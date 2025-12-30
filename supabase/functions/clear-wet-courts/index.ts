import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ClearWetCourtsRequest {
  device_id: string
  court_ids?: string[]       // Optional: specific courts. If omitted, all courts
  idempotency_key?: string   // Prevent duplicate operations
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const serverNow = new Date().toISOString()
  let requestData: ClearWetCourtsRequest | null = null

  try {
    requestData = await req.json() as ClearWetCourtsRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // ===========================================
    // VERIFY DEVICE (Admin only)
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

    if (device.device_type !== 'admin') {
      await supabase.from('audit_log').insert({
        action: 'clear_wet_courts_unauthorized',
        entity_type: 'block',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: device.id,
        device_type: device.device_type,
        initiated_by: 'user',
        request_data: requestData,
        outcome: 'denied',
        error_message: 'Admin access required',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        created_at: serverNow,
      })

      return new Response(JSON.stringify({
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Admin access required',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403,
      })
    }

    // Update device last_seen_at
    await supabase
      .from('devices')
      .update({ last_seen_at: serverNow })
      .eq('id', requestData.device_id)

    // ===========================================
    // GET TARGET COURTS
    // ===========================================

    let courtIds: string[]

    if (requestData.court_ids && requestData.court_ids.length > 0) {
      courtIds = requestData.court_ids
    } else {
      // All courts
      const { data: allCourts, error: courtsError } = await supabase
        .from('courts')
        .select('id')
        .order('court_number')

      if (courtsError || !allCourts) {
        throw new Error('Failed to fetch courts')
      }
      courtIds = allCourts.map(c => c.id)
    }

    if (courtIds.length === 0) {
      throw new Error('No courts found')
    }

    // ===========================================
    // CANCEL ALL ACTIVE WET BLOCKS FOR TARGET COURTS
    // ===========================================

    const { data: cancelledBlocks, error: cancelError } = await supabase
      .from('blocks')
      .update({ cancelled_at: serverNow })
      .in('court_id', courtIds)
      .eq('block_type', 'wet')
      .is('cancelled_at', null)
      .lte('starts_at', serverNow)
      .gte('ends_at', serverNow)
      .select('id, court_id')

    if (cancelError) {
      throw new Error(`Failed to clear wet blocks: ${cancelError.message}`)
    }

    const cancelledCount = cancelledBlocks?.length || 0

    // Get court numbers for the cancelled blocks
    let courtNumbers: number[] = []
    if (cancelledBlocks && cancelledBlocks.length > 0) {
      const cancelledCourtIds = cancelledBlocks.map(b => b.court_id)
      const { data: courts } = await supabase
        .from('courts')
        .select('court_number')
        .in('id', cancelledCourtIds)
        .order('court_number')

      courtNumbers = courts?.map(c => c.court_number) || []
    }

    // ===========================================
    // EMIT SINGLE BOARD CHANGE SIGNAL
    // ===========================================

    if (cancelledCount > 0) {
      await supabase
        .from('board_change_signals')
        .insert({ change_type: 'block' })
    }

    // ===========================================
    // SINGLE AUDIT LOG ENTRY
    // ===========================================

    await supabase.from('audit_log').insert({
      action: 'clear_wet_courts',
      entity_type: 'block',
      entity_id: cancelledBlocks?.[0]?.id || '00000000-0000-0000-0000-000000000000',
      device_id: requestData.device_id,
      device_type: device.device_type,
      initiated_by: 'user',
      request_data: {
        court_ids_requested: requestData.court_ids || 'all',
        idempotency_key: requestData.idempotency_key,
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
      blocks_cleared: cancelledCount,
      court_numbers: courtNumbers,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Audit log - failure
    await supabase.from('audit_log').insert({
      action: 'clear_wet_courts',
      entity_type: 'block',
      entity_id: '00000000-0000-0000-0000-000000000000',
      device_id: requestData?.device_id || null,
      device_type: 'admin',
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
