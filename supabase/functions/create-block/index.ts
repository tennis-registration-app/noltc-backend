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

// Denial codes for expected business rule failures (HTTP 200)
type DenialCode =
  | 'MISSING_COURT_ID'
  | 'INVALID_BLOCK_TYPE'
  | 'MISSING_TITLE'
  | 'MISSING_STARTS_AT'
  | 'MISSING_ENDS_AT'
  | 'MISSING_DEVICE_ID'
  | 'INVALID_STARTS_AT'
  | 'INVALID_ENDS_AT'
  | 'INVALID_DATE_RANGE'
  | 'MISSING_RECURRENCE_RULE'
  | 'DEVICE_NOT_REGISTERED'
  | 'UNAUTHORIZED'
  | 'COURT_NOT_FOUND'
  | 'OVERLAPPING_BLOCK'
  | 'ACTIVE_SESSION'

/**
 * Standard success response with CORS
 */
function successResponse(data: Record<string, unknown>, serverNow: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    code: 'OK',
    message: '',
    serverNow,
    data,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 200,
  })
}

/**
 * Standard denial response (expected business rule failure) with CORS
 * Returns HTTP 200 - this is an expected denial, not an error
 */
function denialResponse(code: DenialCode, message: string, serverNow: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    code,
    message,
    serverNow,
    data: null,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 200,
  })
}

/**
 * Authorization failure response with CORS
 * Returns HTTP 403
 */
function forbiddenResponse(message: string, serverNow: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    code: 'UNAUTHORIZED',
    message,
    serverNow,
    data: null,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 403,
  })
}

/**
 * Internal error response (unexpected failure) with CORS
 * Returns HTTP 500
 */
function internalErrorResponse(message: string, serverNow: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    code: 'INTERNAL_ERROR',
    message,
    serverNow,
    data: null,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 500,
  })
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
      return denialResponse('MISSING_COURT_ID', 'court_id is required', serverNow)
    }
    if (!requestData.block_type || !['lesson', 'clinic', 'maintenance', 'wet', 'other'].includes(requestData.block_type)) {
      return denialResponse('INVALID_BLOCK_TYPE', 'block_type must be "lesson", "clinic", "maintenance", "wet", or "other"', serverNow)
    }
    if (!requestData.title || requestData.title.trim() === '') {
      return denialResponse('MISSING_TITLE', 'title is required', serverNow)
    }
    if (!requestData.starts_at) {
      return denialResponse('MISSING_STARTS_AT', 'starts_at is required', serverNow)
    }
    if (!requestData.ends_at) {
      return denialResponse('MISSING_ENDS_AT', 'ends_at is required', serverNow)
    }
    if (!requestData.device_id) {
      return denialResponse('MISSING_DEVICE_ID', 'device_id is required', serverNow)
    }

    // Validate dates
    const startsAt = new Date(requestData.starts_at)
    const endsAt = new Date(requestData.ends_at)

    if (isNaN(startsAt.getTime())) {
      return denialResponse('INVALID_STARTS_AT', 'starts_at is not a valid date', serverNow)
    }
    if (isNaN(endsAt.getTime())) {
      return denialResponse('INVALID_ENDS_AT', 'ends_at is not a valid date', serverNow)
    }
    if (endsAt <= startsAt) {
      return denialResponse('INVALID_DATE_RANGE', 'ends_at must be after starts_at', serverNow)
    }

    // Validate recurrence
    if (requestData.is_recurring && !requestData.recurrence_rule) {
      return denialResponse('MISSING_RECURRENCE_RULE', 'recurrence_rule is required when is_recurring is true', serverNow)
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
      return denialResponse('DEVICE_NOT_REGISTERED', 'Device not registered', serverNow)
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
          action: 'block_create_unauthorized',
          entity_type: 'block',
          entity_id: '00000000-0000-0000-0000-000000000000',
          device_id: device.id,
          device_type: device.device_type,
          initiated_by: requestData.initiated_by || 'user',
          request_data: {
            court_id: requestData.court_id,
            block_type: requestData.block_type,
            title: requestData.title,
          },
          outcome: 'denied',
          error_message: 'Admin access required',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })

      return forbiddenResponse('Admin access required to create court blocks', serverNow)
    }

    // ===========================================
    // VERIFY COURT EXISTS AND IS ACTIVE
    // ===========================================

    const { data: court, error: courtError } = await supabase
      .from('courts')
      .select('*')
      .eq('id', requestData.court_id)
      .single()

    if (courtError || !court) {
      return denialResponse('COURT_NOT_FOUND', 'Court not found', serverNow)
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
      return denialResponse('OVERLAPPING_BLOCK', `Overlaps with existing block: "${existing.title}"`, serverNow)
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
        return denialResponse('ACTIVE_SESSION', 'Court has an active session. End the session before blocking.', serverNow)
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
      console.error('Failed to create block:', blockError)
      return internalErrorResponse(`Failed to create block: ${blockError?.message}`, serverNow)
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

    // Insert board change signal for real-time updates
    await supabase
      .from("board_change_signals")
      .insert({ change_type: "block" });

    return successResponse({
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
    }, serverNow)

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

    console.error('Unexpected error in create-block:', error)
    return internalErrorResponse(error.message, serverNow)
  }
})
