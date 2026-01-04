import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  let sessionId = '75ab7b75-a212-43cd-9dba-3b9cc80706be'
  let courtId: string | null = null
  try {
    const body = await req.json()
    if (body.session_id) sessionId = body.session_id
    if (body.court_id) courtId = body.court_id
  } catch {}

  // Query 1: Session state
  const { data: sessionState, error: e1 } = await supabase
    .from('sessions')
    .select('id, court_id, actual_end_at, end_reason, started_at, scheduled_end_at')
    .eq('id', sessionId)
    .single()

  // Query 2: Session events
  const { data: sessionEvents, error: e2 } = await supabase
    .from('session_events')
    .select('event_type, created_at, event_data')
    .eq('session_id', sessionId)
    .order('created_at')

  // Query 3: Check active_sessions_view
  const { data: activeView, error: e3 } = await supabase
    .from('active_sessions_view')
    .select('*')
    .eq('id', sessionId)

  // Derive logic manually
  const hasEndEvent = sessionEvents?.some(e => e.event_type === 'END') || false
  const hasRestoreEvent = sessionEvents?.some(e => e.event_type === 'RESTORE') || false

  let hasNewerRestore = false
  if (hasEndEvent && hasRestoreEvent) {
    const lastEndTime = sessionEvents
      ?.filter(e => e.event_type === 'END')
      .map(e => new Date(e.created_at).getTime())
      .sort((a, b) => b - a)[0]
    const lastRestoreTime = sessionEvents
      ?.filter(e => e.event_type === 'RESTORE')
      .map(e => new Date(e.created_at).getTime())
      .sort((a, b) => b - a)[0]
    hasNewerRestore = lastRestoreTime > lastEndTime
  }

  // If courtId provided, also run the exact query that assign-court uses
  let assignCourtQuery = null
  if (courtId) {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, scheduled_end_at')
      .eq('court_id', courtId)
      .is('actual_end_at', null)
      .order('started_at', { ascending: false })
    assignCourtQuery = { data, error: error?.message }
  }

  return new Response(JSON.stringify({
    sessionId,
    courtId,
    sessionState,
    sessionEvents,
    activeViewResult: activeView,
    assignCourtQuery,
    analysis: {
      actualEndAtIsNull: sessionState?.actual_end_at === null,
      hasEndEvent,
      hasRestoreEvent,
      hasNewerRestore,
      shouldBeActive: sessionState?.actual_end_at === null && (!hasEndEvent || hasNewerRestore),
      viewReturnsSession: activeView && activeView.length > 0,
    },
    errors: { e1, e2, e3 },
  }, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
