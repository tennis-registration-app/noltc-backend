import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface RestoreSessionRequest {
  displaced_session_id: string
  takeover_session_id: string
  device_id: string
  device_type?: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const serverNow = new Date().toISOString()
  let requestData: RestoreSessionRequest | null = null

  try {
    requestData = await req.json() as RestoreSessionRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.displaced_session_id) {
      throw new Error('displaced_session_id is required')
    }

    if (!requestData.takeover_session_id) {
      throw new Error('takeover_session_id is required')
    }

    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // ===========================================
    // VERIFY DEVICE
    // ===========================================

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('id, device_type, is_active')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      throw new Error('Device not registered')
    }

    if (!device.is_active) {
      throw new Error('Device is not active')
    }

    // Update device last_seen_at
    await supabase
      .from('devices')
      .update({ last_seen_at: serverNow })
      .eq('id', requestData.device_id)

    // ===========================================
    // ATOMIC VALIDATION - All checks in one query block
    // ===========================================

    // 1. Get displaced session
    const { data: displacedSession, error: sessionError } = await supabase
      .from('sessions')
      .select('id, court_id, actual_end_at, end_reason')
      .eq('id', requestData.displaced_session_id)
      .single()

    if (sessionError || !displacedSession) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'RESTORE_CONFLICT',
        message: 'Displaced session not found',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // 2. Check session is ended
    if (!displacedSession.actual_end_at) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'RESTORE_CONFLICT',
        message: 'Session is still active, cannot restore',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // 3. Check last END event has trigger = 'overtime_takeover'
    const { data: endEvent, error: eventError } = await supabase
      .from('session_events')
      .select('id, event_type, event_data')
      .eq('session_id', requestData.displaced_session_id)
      .eq('event_type', 'END')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (eventError || !endEvent) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'RESTORE_CONFLICT',
        message: 'No END event found for session',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    const eventData = endEvent.event_data as Record<string, unknown> | null
    if (eventData?.trigger !== 'overtime_takeover') {
      return new Response(JSON.stringify({
        ok: false,
        code: 'RESTORE_CONFLICT',
        message: 'Session was not ended by overtime takeover',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // 4. Check court currently has no active session
    const { data: activeSession, error: activeError } = await supabase
      .from('sessions')
      .select('id')
      .eq('court_id', displacedSession.court_id)
      .is('actual_end_at', null)
      .limit(1)

    if (activeError) {
      throw new Error(`Failed to check court availability: ${activeError.message}`)
    }

    if (activeSession && activeSession.length > 0) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'RESTORE_CONFLICT',
        message: 'Court is currently occupied by another session',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ===========================================
    // RESTORE SESSION
    // ===========================================

    // 1. Insert RESTORE event to session_events
    const { error: restoreEventError } = await supabase
      .from('session_events')
      .insert({
        session_id: requestData.displaced_session_id,
        event_type: 'RESTORE',
        event_data: {
          restored_at: serverNow,
          restored_by: requestData.device_id,
          trigger: 'takeover_cancelled',
          takeover_session_id: requestData.takeover_session_id,
        },
        created_by: requestData.device_id,
      })

    if (restoreEventError) {
      throw new Error(`Failed to insert RESTORE event: ${restoreEventError.message}`)
    }

    // 2. Update sessions table - clear actual_end_at and end_reason
    const { error: updateError } = await supabase
      .from('sessions')
      .update({
        actual_end_at: null,
        end_reason: null,
      })
      .eq('id', requestData.displaced_session_id)

    if (updateError) {
      throw new Error(`Failed to restore session: ${updateError.message}`)
    }

    // ===========================================
    // EMIT BOARD CHANGE SIGNAL
    // ===========================================

    await signalBoardChange(supabase, 'session');

    // ===========================================
    // AUDIT LOG
    // ===========================================

    await supabase.from('audit_log').insert({
      action: 'session_restore',
      entity_type: 'session',
      entity_id: requestData.displaced_session_id,
      device_id: requestData.device_id,
      device_type: device.device_type,
      initiated_by: 'user',
      request_data: {
        displaced_session_id: requestData.displaced_session_id,
        takeover_session_id: requestData.takeover_session_id,
      },
      outcome: 'success',
      ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      created_at: serverNow,
    })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      restoredSessionId: requestData.displaced_session_id,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Audit log - failure
    await supabase.from('audit_log').insert({
      action: 'session_restore',
      entity_type: 'session',
      entity_id: requestData?.displaced_session_id || '00000000-0000-0000-0000-000000000000',
      device_id: requestData?.device_id || null,
      device_type: requestData?.device_type || null,
      initiated_by: 'user',
      request_data: requestData,
      outcome: 'failure',
      error_message: error.message,
      ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      created_at: serverNow,
    })

    return new Response(JSON.stringify({
      ok: false,
      serverNow,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  }
})
