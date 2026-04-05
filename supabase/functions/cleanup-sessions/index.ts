import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CleanupRequest {
  device_id: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const serverNow = new Date().toISOString()

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Parse request
    const requestData: CleanupRequest = await req.json()

    if (!requestData.device_id) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'MISSING_DEVICE_ID',
        message: 'device_id is required',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // Verify device exists
    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'DEVICE_NOT_FOUND',
        message: 'Device not registered',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // Check admin authorization
    if (device.device_type !== 'admin') {
      await supabase
        .from('audit_log')
        .insert({
          action: 'cleanup_sessions_unauthorized',
          entity_type: 'session',
          entity_id: '00000000-0000-0000-0000-000000000000',
          device_id: device.id,
          device_type: device.device_type,
          outcome: 'denied',
          error_message: 'Admin access required',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })

      return new Response(JSON.stringify({
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Admin access required for cleanup operations',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403,
      })
    }

    // Get all active sessions grouped by court
    const { data: sessions, error: fetchError } = await supabase
      .from('sessions')
      .select('id, court_id, started_at')
      .is('actual_end_at', null)
      .order('started_at', { ascending: false })

    if (fetchError) {
      return new Response(JSON.stringify({ ok: false, error: fetchError.message }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      })
    }

    // CLEANUP 1: Fix orphaned sessions (have END event but actual_end_at is null)
    // This can happen if end-session was called before the fix was deployed
    const { data: orphanedSessions, error: orphanError } = await supabase
      .from('session_events')
      .select('session_id, created_at')
      .eq('event_type', 'END')

    const orphanedToFix: { id: string; endedAt: string }[] = []
    if (!orphanError && orphanedSessions) {
      const endedSessionIds = new Set(orphanedSessions.map(e => e.session_id))
      const endEventTimes: Record<string, string> = {}
      for (const e of orphanedSessions) {
        endEventTimes[e.session_id] = e.created_at
      }

      for (const s of sessions || []) {
        if (endedSessionIds.has(s.id)) {
          orphanedToFix.push({
            id: s.id,
            endedAt: endEventTimes[s.id] || new Date().toISOString()
          })
        }
      }
    }

    // Fix orphaned sessions by setting actual_end_at to END event time
    let orphanedFixed = 0
    const fixErrors: string[] = []
    for (const orphan of orphanedToFix) {
      const { error: fixError } = await supabase
        .from('sessions')
        .update({
          actual_end_at: orphan.endedAt,
          end_reason: 'cleared_early'  // These are sessions that were cleared but actual_end_at wasn't set
        })
        .eq('id', orphan.id)

      if (fixError) {
        console.error('Cleanup: fix error for', orphan.id, fixError)
        fixErrors.push(`${orphan.id}: ${fixError.message}`)
      } else {
        orphanedFixed++
      }
    }

    // CLEANUP 2: Group by court_id and find duplicates (keep newest)
    // Exclude orphaned sessions we just fixed
    const fixedIds = new Set(orphanedToFix.map(o => o.id))
    const remainingSessions = (sessions || []).filter(s => !fixedIds.has(s.id))

    const courtSessions: Record<string, any[]> = {}
    for (const s of remainingSessions) {
      if (!courtSessions[s.court_id]) {
        courtSessions[s.court_id] = []
      }
      courtSessions[s.court_id].push(s)
    }

    // Find sessions to end (all but the first/newest per court)
    const toEnd: string[] = []
    for (const courtId in courtSessions) {
      const courtList = courtSessions[courtId]
      if (courtList.length > 1) {
        // Skip first (newest), end the rest
        for (let i = 1; i < courtList.length; i++) {
          toEnd.push(courtList[i].id)
        }
      }
    }

    // End the duplicate sessions with valid end_reason
    let duplicatesEnded = 0
    if (toEnd.length > 0) {
      const { error: updateError } = await supabase
        .from('sessions')
        .update({
          actual_end_at: new Date().toISOString(),
          end_reason: 'admin_override'
        })
        .in('id', toEnd)

      if (!updateError) {
        duplicatesEnded = toEnd.length
      }
    }

    // Signal board refresh (only if we actually changed something)
    if (orphanedFixed > 0 || duplicatesEnded > 0) {
      await signalBoardChange(supabase, 'session');
    }

    return new Response(JSON.stringify({
      ok: true,
      message: `Fixed ${orphanedFixed} orphaned sessions, ended ${duplicatesEnded} duplicates`,
      sessionsChecked: sessions?.length || 0,
      endEventsFound: orphanedSessions?.length || 0,
      orphanedFound: orphanedToFix.length,
      orphanedFixed,
      fixErrors: fixErrors.length > 0 ? fixErrors : undefined,
      duplicatesEnded,
      endedIds: toEnd
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    })
  }
})
