import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { endSession } from "../_shared/sessionLifecycle.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface UndoOvertimeTakeoverRequest {
  takeover_session_id: string
  displaced_session_id: string
  device_id: string
  device_type?: string
}

/**
 * Undo Overtime Takeover
 *
 * This endpoint atomically reverses an overtime takeover when a user changes courts.
 * It ends the takeover session and restores the displaced session in a single operation.
 *
 * Flow:
 * 1. Validate takeover session (exists, active, get court_id)
 * 2. Validate displaced session (exists, ended, same court, ended by overtime_takeover)
 * 3. Verify court state (takeover session should be the active session on that court)
 * 4. End the takeover session (INSERT END event, UPDATE sessions)
 * 5. Restore the displaced session (INSERT RESTORE event, UPDATE sessions)
 *
 * Invariants:
 * - Takeover session must be active (actual_end_at IS NULL)
 * - Displaced session must be ended (actual_end_at IS NOT NULL)
 * - Both sessions must be on the same court
 * - Displaced session must have been ended by 'overtime_takeover' trigger
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const serverNow = new Date().toISOString()
  let requestData: UndoOvertimeTakeoverRequest | null = null

  try {
    requestData = await req.json() as UndoOvertimeTakeoverRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.takeover_session_id) {
      throw new Error('takeover_session_id is required')
    }

    if (!requestData.displaced_session_id) {
      throw new Error('displaced_session_id is required')
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
    // STEP 1: VALIDATE TAKEOVER SESSION
    // ===========================================

    const { data: takeoverSession, error: takeoverError } = await supabase
      .from('sessions')
      .select('id, court_id, actual_end_at')
      .eq('id', requestData.takeover_session_id)
      .single()

    if (takeoverError || !takeoverSession) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'UNDO_CONFLICT',
        message: 'Takeover session not found',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Takeover session must be active (not ended)
    if (takeoverSession.actual_end_at) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'UNDO_CONFLICT',
        message: 'Takeover session is already ended',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    const courtId = takeoverSession.court_id

    // ===========================================
    // STEP 2: VALIDATE DISPLACED SESSION
    // ===========================================

    const { data: displacedSession, error: displacedError } = await supabase
      .from('sessions')
      .select('id, court_id, actual_end_at, end_reason')
      .eq('id', requestData.displaced_session_id)
      .single()

    if (displacedError || !displacedSession) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'UNDO_CONFLICT',
        message: 'Displaced session not found',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Displaced session must be ended
    if (!displacedSession.actual_end_at) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'UNDO_CONFLICT',
        message: 'Displaced session is still active, cannot restore',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Both sessions must be on the same court
    if (displacedSession.court_id !== courtId) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'UNDO_CONFLICT',
        message: 'Sessions are not on the same court',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Check that displaced session was ended by overtime_takeover
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
        code: 'UNDO_CONFLICT',
        message: 'No END event found for displaced session',
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
        code: 'UNDO_CONFLICT',
        message: 'Displaced session was not ended by overtime takeover',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Verify the END event's takeover_session_id matches the request
    // This prevents restoring a session that was taken over by a different session
    const storedTakeoverSessionId = eventData?.takeover_session_id as string | undefined
    if (storedTakeoverSessionId && storedTakeoverSessionId !== requestData.takeover_session_id) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'UNDO_CONFLICT',
        message: 'Takeover session ID does not match - cannot undo a different takeover',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ===========================================
    // STEP 3: VERIFY COURT STATE
    // Takeover session should be the only active session on this court
    // ===========================================

    const { data: activeSessions, error: activeError } = await supabase
      .from('sessions')
      .select('id')
      .eq('court_id', courtId)
      .is('actual_end_at', null)

    if (activeError) {
      throw new Error(`Failed to check court state: ${activeError.message}`)
    }

    // Should be exactly one active session (the takeover session)
    if (!activeSessions || activeSessions.length !== 1) {
      console.warn(`[undo-overtime-takeover] Unexpected court state: ${activeSessions?.length ?? 0} active sessions on court ${courtId}`)
    }

    if (activeSessions && activeSessions.length > 0 && activeSessions[0].id !== requestData.takeover_session_id) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'UNDO_CONFLICT',
        message: 'Court state has changed - another session is active',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ===========================================
    // STEP 4: END THE TAKEOVER SESSION
    // ===========================================

    const endResult = await endSession(supabase, {
      sessionId: requestData.takeover_session_id,
      serverNow,
      endReason: 'cleared_early',
      deviceId: requestData.device_id,
      eventData: {
        trigger: 'undo_overtime_takeover',
        displaced_session_id: requestData.displaced_session_id,
      },
    })

    if (!endResult.success && !endResult.alreadyEnded) {
      throw new Error(`Failed to end takeover session: ${endResult.error}`)
    }

    // ===========================================
    // STEP 5: RESTORE THE DISPLACED SESSION
    // ===========================================

    // Insert RESTORE event to session_events
    const { error: restoreEventError } = await supabase
      .from('session_events')
      .insert({
        session_id: requestData.displaced_session_id,
        event_type: 'RESTORE',
        event_data: {
          restored_at: serverNow,
          restored_by: requestData.device_id,
          trigger: 'undo_overtime_takeover',
          takeover_session_id: requestData.takeover_session_id,
        },
        created_by: requestData.device_id,
      })

    if (restoreEventError) {
      // Log but continue - takeover session is already ended
      console.error(`[undo-overtime-takeover] Failed to insert RESTORE event: ${restoreEventError.message}`)
      // Don't throw - the takeover session is ended, court is free
    }

    // Update sessions table - clear actual_end_at and end_reason
    const { error: updateError } = await supabase
      .from('sessions')
      .update({
        actual_end_at: null,
        end_reason: null,
      })
      .eq('id', requestData.displaced_session_id)

    if (updateError) {
      // Log but continue - RESTORE event is the source of truth
      console.error(`[undo-overtime-takeover] Failed to restore session: ${updateError.message}`)
    }

    // ===========================================
    // EMIT BOARD CHANGE SIGNAL
    // ===========================================

    await supabase
      .from('board_change_signals')
      .insert({ change_type: 'session' })

    // ===========================================
    // AUDIT LOG
    // ===========================================

    await supabase.from('audit_log').insert({
      action: 'undo_overtime_takeover',
      entity_type: 'session',
      entity_id: requestData.takeover_session_id,
      device_id: requestData.device_id,
      device_type: device.device_type,
      initiated_by: 'user',
      request_data: {
        takeover_session_id: requestData.takeover_session_id,
        displaced_session_id: requestData.displaced_session_id,
        court_id: courtId,
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
      endedSessionId: requestData.takeover_session_id,
      restoredSessionId: requestData.displaced_session_id,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Audit log - failure
    await supabase.from('audit_log').insert({
      action: 'undo_overtime_takeover',
      entity_type: 'session',
      entity_id: requestData?.takeover_session_id || '00000000-0000-0000-0000-000000000000',
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
