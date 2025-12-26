import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { endSession, signalBoardChange } from '../_shared/sessionLifecycle.ts'

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
    const { device_id, reason } = body
    const serverNow = new Date().toISOString()

    // Validate device_id
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
          action: 'clear_all_courts_unauthorized',
          entity_type: 'session',
          entity_id: '00000000-0000-0000-0000-000000000000',
          device_id: device.id,
          device_type: device.device_type,
          request_data: { reason },
          outcome: 'denied',
          error_message: 'Admin access required',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
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

    // Get all active sessions
    const { data: activeSessions, error: sessionsError } = await supabase
      .from('sessions')
      .select('id, court_id')
      .is('actual_end_at', null)

    if (sessionsError) {
      throw sessionsError
    }

    if (!activeSessions || activeSessions.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          message: 'No active sessions to clear',
          sessionsEnded: 0,
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // End each session using shared helper
    let sessionsEnded = 0

    for (const session of activeSessions) {
      const result = await endSession(supabase, {
        sessionId: session.id,
        serverNow,
        endReason: 'admin_override',
        deviceId: device_id,
        eventData: {
          admin_reason: reason || 'clear_all_courts',
        },
      })

      // Skip already-ended sessions (shouldn't happen but handle gracefully)
      if (result.success) {
        sessionsEnded++
      }
    }

    // Signal board change
    await signalBoardChange(supabase, 'session')

    // Audit log
    await supabase
      .from('audit_log')
      .insert({
        action: 'clear_all_courts',
        entity_type: 'session',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: device.id,
        device_type: device.device_type,
        request_data: {
          reason: reason || 'admin_override',
          sessions_ended: sessionsEnded,
          session_ids: activeSessions.map(s => s.id),
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    return new Response(
      JSON.stringify({
        ok: true,
        message: `Cleared ${sessionsEnded} active sessions`,
        sessionsEnded,
        serverNow,
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
