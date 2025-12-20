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

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  try {
    // Get court availability with active sessions
    const { data: courts, error: courtsError } = await supabase
      .from('court_availability_view')
      .select('*')
      .order('sort_order')

    if (courtsError) {
      throw new Error(`Failed to fetch courts: ${courtsError.message}`)
    }

    // Get active sessions with participants
    const { data: sessions, error: sessionsError } = await supabase
      .from('active_sessions_view')
      .select('*')
      .order('sort_order')

    if (sessionsError) {
      throw new Error(`Failed to fetch sessions: ${sessionsError.message}`)
    }

    // Get active blocks
    const now = new Date().toISOString()
    const { data: blocks, error: blocksError } = await supabase
      .from('blocks')
      .select(`
        id,
        court_id,
        block_type,
        title,
        starts_at,
        ends_at,
        courts(court_number)
      `)
      .is('cancelled_at', null)
      .lte('starts_at', now)
      .gt('ends_at', now)

    if (blocksError) {
      throw new Error(`Failed to fetch blocks: ${blocksError.message}`)
    }

    // Combine into a unified response
    const courtStatus = courts?.map(court => {
      const session = sessions?.find(s => s.court_id === court.court_id && s.session_id)
      const block = blocks?.find(b => b.court_id === court.court_id)

      return {
        court_id: court.court_id,
        court_number: court.court_number,
        court_name: court.court_name,
        status: court.status,
        session: session?.session_id ? {
          id: session.session_id,
          type: session.session_type,
          started_at: session.started_at,
          scheduled_end_at: session.scheduled_end_at,
          // Use Math.ceil to round UP - prevents false "overtime" when seconds remain
          // E.g., 0.4 minutes (24 seconds) remaining should show as 1, not 0
          minutes_remaining: Math.max(0, Math.ceil(session.minutes_remaining)),
          participants: session.participant_names || [],
        } : null,
        block: block ? {
          id: block.id,
          type: block.block_type,
          title: block.title,
          ends_at: block.ends_at,
        } : null,
      }
    })

    return new Response(JSON.stringify({
      ok: true,
      timestamp: new Date().toISOString(),
      courts: courtStatus,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
