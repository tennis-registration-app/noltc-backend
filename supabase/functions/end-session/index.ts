import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface EndSessionRequest {
  session_id?: string
  court_id?: string  // Alternative: end session by court
  end_reason: 'completed' | 'cleared_early' | 'admin_override'
  device_id: string
  device_type: string
  initiated_by?: 'user' | 'ai_assistant' | 'system'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  let requestData: EndSessionRequest | null = null
  let sessionId: string | null = null

  try {
    requestData = await req.json() as EndSessionRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.session_id && !requestData.court_id) {
      throw new Error('Either session_id or court_id is required')
    }
    if (!requestData.end_reason || !['completed', 'cleared_early', 'admin_override'].includes(requestData.end_reason)) {
      throw new Error('end_reason must be "completed", "cleared_early", or "admin_override"')
    }
    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // ===========================================
    // VERIFY DEVICE EXISTS
    // ===========================================

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      throw new Error('Device not registered')
    }

    // Update device last_seen_at
    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    // ===========================================
    // FIND THE SESSION
    // ===========================================

    let session

    if (requestData.session_id) {
      // Find by session_id
      const { data, error } = await supabase
        .from('sessions')
        .select('*, courts(court_number, name)')
        .eq('id', requestData.session_id)
        .is('actual_end_at', null)
        .single()

      if (error || !data) {
        throw new Error('Active session not found')
      }
      session = data
    } else {
      // Find by court_id (get the active session on that court)
      const { data, error } = await supabase
        .from('sessions')
        .select('*, courts(court_number, name)')
        .eq('court_id', requestData.court_id)
        .is('actual_end_at', null)
        .single()

      if (error || !data) {
        throw new Error('No active session on this court')
      }
      session = data
    }

    sessionId = session.id

    // ===========================================
    // GET PARTICIPANTS (for response)
    // ===========================================

    const { data: participants } = await supabase
      .from('session_participants')
      .select(`
        participant_type,
        guest_name,
        members(display_name)
      `)
      .eq('session_id', session.id)

    const participantNames = participants?.map(p =>
      p.participant_type === 'member' ? p.members?.display_name : p.guest_name
    ) || []

    // ===========================================
    // END THE SESSION
    // ===========================================

    const actualEndAt = new Date().toISOString()

    const { error: updateError } = await supabase
      .from('sessions')
      .update({
        actual_end_at: actualEndAt,
        end_reason: requestData.end_reason,
        ended_by_device_id: requestData.device_id,
      })
      .eq('id', session.id)

    if (updateError) {
      throw new Error(`Failed to end session: ${updateError.message}`)
    }

    // ===========================================
    // CALCULATE ACTUAL DURATION
    // ===========================================

    const startedAt = new Date(session.started_at)
    const endedAt = new Date(actualEndAt)
    const actualDurationMinutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000)

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'session_end',
        entity_type: 'session',
        entity_id: session.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        request_data: {
          court_number: session.courts?.court_number,
          end_reason: requestData.end_reason,
          scheduled_duration: session.duration_minutes,
          actual_duration: actualDurationMinutes,
          participant_count: participantNames.length,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      session: {
        id: session.id,
        court_id: session.court_id,
        court_number: session.courts?.court_number,
        court_name: session.courts?.name,
        session_type: session.session_type,
        started_at: session.started_at,
        ended_at: actualEndAt,
        end_reason: requestData.end_reason,
        scheduled_duration_minutes: session.duration_minutes,
        actual_duration_minutes: actualDurationMinutes,
        participants: participantNames,
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Audit log - failure
    await supabase
      .from('audit_log')
      .insert({
        action: 'session_end',
        entity_type: 'session',
        entity_id: sessionId || '00000000-0000-0000-0000-000000000000',
        device_id: requestData?.device_id || null,
        device_type: requestData?.device_type || null,
        initiated_by: requestData?.initiated_by || 'user',
        request_data: requestData,
        outcome: 'failure',
        error_message: error.message,
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    return new Response(JSON.stringify({
      ok: false,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
