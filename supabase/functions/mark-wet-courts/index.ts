import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface MarkWetCourtsRequest {
  device_id: string
  duration_minutes?: number  // Default: 720 (12 hours)
  court_ids?: string[]       // Optional: specific courts. If omitted, all courts
  reason?: string            // Optional: defaults to 'WET COURT'
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
  let requestData: MarkWetCourtsRequest | null = null

  try {
    requestData = await req.json() as MarkWetCourtsRequest

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
        action: 'mark_wet_courts_unauthorized',
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
    // IDEMPOTENCY CHECK
    // ===========================================

    const idempotencyKey = requestData.idempotency_key || `wet-${Date.now()}`

    // Check for existing wet blocks created with same idempotency pattern
    // We use a deterministic key based on the action
    const { data: existingAction } = await supabase
      .from('audit_log')
      .select('id, created_at')
      .eq('action', 'mark_wet_courts')
      .eq('outcome', 'success')
      .contains('request_data', { idempotency_key: idempotencyKey })
      .maybeSingle()

    if (existingAction) {
      return new Response(JSON.stringify({
        ok: true,
        serverNow,
        idempotent: true,
        message: 'Wet courts already marked (idempotent)',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ===========================================
    // GET TARGET COURTS
    // ===========================================

    let courts: { id: string; court_number: number }[]

    if (requestData.court_ids && requestData.court_ids.length > 0) {
      // Specific courts requested
      const { data: selectedCourts, error: courtsError } = await supabase
        .from('courts')
        .select('id, court_number')
        .in('id', requestData.court_ids)
        .order('court_number')

      if (courtsError || !selectedCourts) {
        throw new Error('Failed to fetch courts')
      }
      courts = selectedCourts
    } else {
      // All courts
      const { data: allCourts, error: courtsError } = await supabase
        .from('courts')
        .select('id, court_number')
        .order('court_number')

      if (courtsError || !allCourts) {
        throw new Error('Failed to fetch courts')
      }
      courts = allCourts
    }

    if (courts.length === 0) {
      throw new Error('No courts found')
    }

    // ===========================================
    // CALCULATE BLOCK TIMES
    // ===========================================

    const durationMinutes = requestData.duration_minutes || 720 // 12 hours default
    const startsAt = new Date()
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000)
    const reason = requestData.reason || 'WET COURT'

    // ===========================================
    // CREATE WET BLOCKS (UPSERT SEMANTICS)
    // Cancel any existing active wet blocks first, then create new ones
    // ===========================================

    // Cancel existing active wet blocks for these courts
    const { data: cancelledBlocks } = await supabase
      .from('blocks')
      .update({ cancelled_at: serverNow })
      .in('court_id', courts.map(c => c.id))
      .eq('block_type', 'wet')
      .is('cancelled_at', null)
      .lte('starts_at', serverNow)
      .gte('ends_at', serverNow)
      .select('id')

    const cancelledCount = cancelledBlocks?.length || 0

    // Create new wet blocks for all target courts
    const blocksToInsert = courts.map(court => ({
      court_id: court.id,
      block_type: 'wet',
      title: reason,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      is_recurring: false,
      recurrence_rule: null,
      created_by_device_id: requestData.device_id,
    }))

    const { data: createdBlocks, error: insertError } = await supabase
      .from('blocks')
      .insert(blocksToInsert)
      .select('id, court_id')

    if (insertError) {
      throw new Error(`Failed to create wet blocks: ${insertError.message}`)
    }

    // ===========================================
    // EMIT SINGLE BOARD CHANGE SIGNAL
    // ===========================================

    await signalBoardChange(supabase, 'block');

    // ===========================================
    // SINGLE AUDIT LOG ENTRY
    // ===========================================

    await supabase.from('audit_log').insert({
      action: 'mark_wet_courts',
      entity_type: 'block',
      entity_id: createdBlocks?.[0]?.id || '00000000-0000-0000-0000-000000000000',
      device_id: requestData.device_id,
      device_type: device.device_type,
      initiated_by: 'user',
      request_data: {
        court_count: courts.length,
        court_numbers: courts.map(c => c.court_number),
        duration_minutes: durationMinutes,
        reason,
        idempotency_key: idempotencyKey,
        cancelled_existing: cancelledCount,
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
      courts_marked: courts.length,
      court_numbers: courts.map(c => c.court_number),
      blocks_created: createdBlocks?.length || 0,
      blocks_cancelled: cancelledCount,
      ends_at: endsAt.toISOString(),
      duration_minutes: durationMinutes,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Audit log - failure
    await supabase.from('audit_log').insert({
      action: 'mark_wet_courts',
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
