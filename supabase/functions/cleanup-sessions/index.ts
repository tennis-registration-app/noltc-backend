import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

    // Group by court_id and find duplicates (keep newest)
    const courtSessions: Record<string, any[]> = {}
    for (const s of sessions || []) {
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

    if (toEnd.length === 0) {
      return new Response(JSON.stringify({ 
        ok: true, 
        message: 'No duplicates found',
        sessionsChecked: sessions?.length || 0
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // End the duplicate sessions with valid end_reason
    const { error: updateError } = await supabase
      .from('sessions')
      .update({ 
        actual_end_at: new Date().toISOString(),
        end_reason: 'admin_override'
      })
      .in('id', toEnd)

    if (updateError) {
      return new Response(JSON.stringify({ ok: false, error: updateError.message }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      })
    }

    return new Response(JSON.stringify({ 
      ok: true, 
      message: `Ended ${toEnd.length} duplicate sessions`,
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
