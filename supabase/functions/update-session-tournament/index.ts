import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface UpdateSessionTournamentRequest {
  session_id: string
  is_tournament: boolean
  device_id: string
  device_type?: string
  initiated_by?: 'user' | 'ai_assistant'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const serverNow = new Date().toISOString()

  let requestData: UpdateSessionTournamentRequest | null = null

  try {
    requestData = await req.json() as UpdateSessionTournamentRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.session_id) {
      throw new Error('session_id is required')
    }
    if (typeof requestData.is_tournament !== 'boolean') {
      throw new Error('is_tournament (boolean) is required')
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

    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    // ===========================================
    // FIND THE SESSION
    // ===========================================

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', requestData.session_id)
      .single()

    if (sessionError || !session) {
      throw new Error('Session not found')
    }

    if (session.actual_end_at !== null) {
      throw new Error('Session has already ended')
    }

    // ===========================================
    // UPDATE TOURNAMENT FLAG
    // ===========================================

    const { error: updateError } = await supabase
      .from('sessions')
      .update({ is_tournament: requestData.is_tournament })
      .eq('id', requestData.session_id)

    if (updateError) {
      throw new Error(`Failed to update is_tournament: ${updateError.message}`)
    }

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: requestData.is_tournament ? 'session_tournament_set' : 'session_tournament_unset',
        entity_type: 'session',
        entity_id: session.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type || null,
        initiated_by: requestData.initiated_by || 'user',
        request_data: {
          session_id: session.id,
          court_id: session.court_id,
          is_tournament: requestData.is_tournament,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // SIGNAL BOARD CHANGE
    // ===========================================

    await signalBoardChange(supabase, 'session')

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      session: {
        id: session.id,
        court_id: session.court_id,
        is_tournament: requestData.is_tournament,
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
        action: 'session_tournament_set',
        entity_type: 'session',
        entity_id: requestData?.session_id || '00000000-0000-0000-0000-000000000000',
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
      serverNow,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  }
})
