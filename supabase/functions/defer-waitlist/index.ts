import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface DeferWaitlistRequest {
  waitlist_id: string
  deferred: boolean
  device_id: string
  device_type: string
  initiated_by?: 'user' | 'ai_assistant'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Consistent timestamp for the entire request
  const serverNow = new Date().toISOString()

  let requestData: DeferWaitlistRequest | null = null

  try {
    requestData = await req.json() as DeferWaitlistRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.waitlist_id) {
      throw new Error('waitlist_id is required')
    }
    if (typeof requestData.deferred !== 'boolean') {
      throw new Error('deferred (boolean) is required')
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
    // FIND THE WAITLIST ENTRY
    // ===========================================

    const { data: waitlistEntry, error: waitlistError } = await supabase
      .from('waitlist')
      .select('*')
      .eq('id', requestData.waitlist_id)
      .single()

    if (waitlistError || !waitlistEntry) {
      throw new Error('Waitlist entry not found')
    }

    if (waitlistEntry.status !== 'waiting') {
      throw new Error(`Cannot defer - status is "${waitlistEntry.status}"`)
    }

    // ===========================================
    // UPDATE DEFERRED FLAG
    // ===========================================

    const { error: updateError } = await supabase
      .from('waitlist')
      .update({ deferred: requestData.deferred })
      .eq('id', requestData.waitlist_id)

    if (updateError) {
      throw new Error(`Failed to update deferred: ${updateError.message}`)
    }

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: requestData.deferred ? 'waitlist_defer' : 'waitlist_undefer',
        entity_type: 'waitlist',
        entity_id: waitlistEntry.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        request_data: {
          group_type: waitlistEntry.group_type,
          position: waitlistEntry.position,
          deferred: requestData.deferred,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    // Signal board change for real-time updates (db insert + broadcast)
    await signalBoardChange(supabase, 'waitlist');

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      waitlist: {
        id: waitlistEntry.id,
        group_type: waitlistEntry.group_type,
        position: waitlistEntry.position,
        deferred: requestData.deferred,
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
        action: 'waitlist_defer',
        entity_type: 'waitlist',
        entity_id: requestData?.waitlist_id || '00000000-0000-0000-0000-000000000000',
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
