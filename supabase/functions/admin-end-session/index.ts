import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json()
    const { device_id, session_id, court_id, reason } = body
    const serverNow = new Date().toISOString()

    // Validate: need device_id for admin auth
    if (!device_id) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'MISSING_DEVICE',
          message: 'device_id is required',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Validate: need either session_id or court_id
    if (!session_id && !court_id) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'MISSING_IDENTIFIER',
          message: 'Either session_id or court_id is required',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Verify admin device
    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('id, device_type, is_active')
      .eq('id', device_id)
      .single()

    if (deviceError || !device) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'INVALID_DEVICE',
          message: 'Device not found',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    if (!device.is_active) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'DEVICE_INACTIVE',
          message: 'Device is not active',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    // Check admin authorization
    if (device.device_type !== 'admin') {
      await supabase
        .from('audit_log')
        .insert({
          action: 'admin_end_session_unauthorized',
          device_id: device.id,
          details: { session_id, court_id, reason },
          created_at: serverNow,
        })

      return new Response(
        JSON.stringify({
          ok: false,
          code: 'UNAUTHORIZED',
          message: 'Admin access required',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 }
      )
    }

    // Find the session to end
    let targetSessionId = session_id
    let targetCourtId = court_id

    if (!targetSessionId && court_id) {
      // Find active session on this court
      const { data: activeSession, error: sessionError } = await supabase
        .from('sessions')
        .select('id, court_id')
        .eq('court_id', court_id)
        .is('actual_end_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .single()

      if (sessionError || !activeSession) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'NO_ACTIVE_SESSION',
            message: 'No active session found on this court',
            serverNow,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
        )
      }

      targetSessionId = activeSession.id
      targetCourtId = activeSession.court_id
    }

    // Get session details before ending
    const { data: session, error: getSessionError } = await supabase
      .from('sessions')
      .select('id, court_id, started_at, session_type')
      .eq('id', targetSessionId)
      .single()

    if (getSessionError || !session) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
      )
    }

    // Insert END event (append-only)
    const { error: eventError } = await supabase
      .from('session_events')
      .insert({
        session_id: targetSessionId,
        event_type: 'END',
        event_data: {
          reason: reason || 'admin_force_end',
          ended_at: serverNow,
          ended_by: device_id,
        },
        created_by: device_id,
      })

    if (eventError) {
      if (eventError.code === '23505') {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'SESSION_ALREADY_ENDED',
            message: 'Session has already been ended',
            serverNow,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 409 }
        )
      }
      throw eventError
    }

    // Update session actual_end_at
    await supabase
      .from('sessions')
      .update({
        actual_end_at: serverNow,
        end_reason: 'admin_override',
      })
      .eq('id', targetSessionId)

    // Insert board change signal
    await supabase
      .from('board_change_signals')
      .insert({ change_type: 'session' })

    // Audit log
    await supabase
      .from('audit_log')
      .insert({
        action: 'admin_end_session',
        entity_type: 'session',
        entity_id: targetSessionId,
        device_id: device.id,
        device_type: device.device_type,
        request_data: {
          session_id: targetSessionId,
          court_id: session.court_id,
          reason: reason || 'admin_force_end',
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    return new Response(
      JSON.stringify({
        ok: true,
        serverNow,
        session: {
          id: session.id,
          courtId: session.court_id,
          endedAt: serverNow,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: error.message,
        serverNow: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
