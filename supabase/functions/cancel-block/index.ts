import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CancelBlockRequest {
  block_id: string
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

  let requestData: CancelBlockRequest | null = null

  try {
    requestData = await req.json() as CancelBlockRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.block_id) {
      throw new Error('block_id is required')
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
    // CHECK ADMIN AUTHORIZATION
    // ===========================================

    if (device.device_type !== 'admin') {
      // Log unauthorized attempt
      await supabase
        .from('audit_log')
        .insert({
          action: 'block_cancel_unauthorized',
          entity_type: 'block',
          entity_id: requestData.block_id,
          device_id: device.id,
          device_type: device.device_type,
          initiated_by: requestData.initiated_by || 'user',
          request_data: {
            block_id: requestData.block_id,
          },
          outcome: 'denied',
          error_message: 'Admin access required',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })

      return new Response(JSON.stringify({
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Admin access required to cancel court blocks',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403,
      })
    }

    // ===========================================
    // FIND THE BLOCK
    // ===========================================

    const { data: block, error: blockError } = await supabase
      .from('blocks')
      .select('*, courts(court_number, name)')
      .eq('id', requestData.block_id)
      .single()

    if (blockError || !block) {
      throw new Error('Block not found')
    }

    if (block.cancelled_at) {
      throw new Error('Block is already cancelled')
    }

    // ===========================================
    // CANCEL THE BLOCK (soft delete)
    // ===========================================

    const cancelledAt = new Date().toISOString()

    const { error: updateError } = await supabase
      .from('blocks')
      .update({ cancelled_at: cancelledAt })
      .eq('id', requestData.block_id)

    if (updateError) {
      throw new Error(`Failed to cancel block: ${updateError.message}`)
    }

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'block_cancel',
        entity_type: 'block',
        entity_id: block.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        request_data: {
          court_number: block.courts?.court_number,
          block_type: block.block_type,
          title: block.title,
          starts_at: block.starts_at,
          ends_at: block.ends_at,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS

    // Insert board change signal for real-time updates
    await supabase
      .from("board_change_signals")
      .insert({ change_type: "block" });
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      block: {
        id: block.id,
        court_id: block.court_id,
        court_number: block.courts?.court_number,
        court_name: block.courts?.name,
        block_type: block.block_type,
        title: block.title,
        starts_at: block.starts_at,
        ends_at: block.ends_at,
        cancelled_at: cancelledAt,
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
        action: 'block_cancel',
        entity_type: 'block',
        entity_id: requestData?.block_id || '00000000-0000-0000-0000-000000000000',
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
