import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CreateBlockRequest {
  court_id: string
  block_type: 'lesson' | 'clinic' | 'maintenance' | 'wet' | 'other'
  title: string
  starts_at: string  // ISO datetime
  ends_at: string    // ISO datetime
  is_recurring?: boolean
  recurrence_rule?: string  // iCal RRULE format
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

  let requestData: CreateBlockRequest | null = null
  let blockId = '00000000-0000-0000-0000-000000000000'

  try {
    requestData = await req.json() as CreateBlockRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.court_id) {
      throw new Error('court_id is required')
    }
    if (!requestData.block_type || !['lesson', 'clinic', 'maintenance', 'wet', 'other'].includes(requestData.block_type)) {
      throw new Error('block_type must be "lesson", "clinic", "maintenance", "wet", or "other"')
    }
    if (!requestData.title || requestData.title.trim() === '') {
      throw new Error('title is required')
    }
    if (!requestData.starts_at) {
      throw new Error('starts_at is required')
    }
    if (!requestData.ends_at) {
      throw new Error('ends_at is required')
    }
    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // Validate dates
    const startsAt = new Date(requestData.starts_at)
    const endsAt = new Date(requestData.ends_at)

    if (isNaN(startsAt.getTime())) {
      throw new Error('starts_at is not a valid date')
    }
    if (isNaN(endsAt.getTime())) {
      throw new Error('ends_at is not a valid date')
    }
    if (endsAt <= startsAt) {
      throw new Error('ends_at must be after starts_at')
    }

    // Validate recurrence
    if (requestData.is_recurring && !requestData.recurrence_rule) {
      throw new Error('recurrence_rule is required when is_recurring is true')
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
    // VERIFY COURT EXISTS AND IS ACTIVE
    // ===========================================

    const { data: court, error: courtError } = await supabase
      .from('courts')
      .select('*')
      .eq('id', requestData.court_id)
      .single()

    if (courtError || !court) {
      throw new Error('Court not found')
    }

    // ===========================================
    // CHECK FOR OVERLAPPING BLOCKS
    // ===========================================

    const { data: overlappingBlocks } = await supabase
      .from('blocks')
      .select('id, title, starts_at, ends_at')
      .eq('court_id', requestData.court_id)
      .is('cancelled_at', null)
      .lt('starts_at', requestData.ends_at)
      .gt('ends_at', requestData.starts_at)

    if (overlappingBlocks && overlappingBlocks.length > 0) {
      const existing = overlappingBlocks[0]
      throw new Error(`Overlaps with existing block: "${existing.title}"`)
    }

    // ===========================================
    // CHECK FOR ACTIVE SESSION DURING BLOCK TIME
    // (Only warn if block starts now or in the past)
    // ===========================================

    const now = new Date()
    if (startsAt <= now) {
      const { data: activeSession } = await supabase
        .from('sessions')
        .select('id')
        .eq('court_id', requestData.court_id)
        .is('actual_end_at', null)
        .single()

      if (activeSession) {
        throw new Error('Court has an active session. End the session before blocking.')
      }
    }

    // ===========================================
    // CREATE THE BLOCK
    // ===========================================

    const { data: block, error: blockError } = await supabase
      .from('blocks')
      .insert({
        court_id: requestData.court_id,
        block_type: requestData.block_type,
        title: requestData.title.trim(),
        starts_at: requestData.starts_at,
        ends_at: requestData.ends_at,
        is_recurring: requestData.is_recurring || false,
        recurrence_rule: requestData.recurrence_rule || null,
        created_by_device_id: requestData.device_id,
      })
      .select()
      .single()

    if (blockError || !block) {
      throw new Error(`Failed to create block: ${blockError?.message}`)
    }

    blockId = block.id

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'block_create',
        entity_type: 'block',
        entity_id: block.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        request_data: {
          court_number: court.court_number,
          block_type: requestData.block_type,
          title: requestData.title,
          starts_at: requestData.starts_at,
          ends_at: requestData.ends_at,
          is_recurring: requestData.is_recurring || false,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    // Calculate duration in minutes
    const durationMinutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      block: {
        id: block.id,
        court_id: block.court_id,
        court_number: court.court_number,
        court_name: court.name,
        block_type: block.block_type,
        title: block.title,
        starts_at: block.starts_at,
        ends_at: block.ends_at,
        duration_minutes: durationMinutes,
        is_recurring: block.is_recurring,
        recurrence_rule: block.recurrence_rule,
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
        action: 'block_create',
        entity_type: 'block',
        entity_id: blockId,
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
