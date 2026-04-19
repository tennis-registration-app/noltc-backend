import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface UpdateBlockRequest {
  block_id: string
  court_id?: string
  block_type?: 'lesson' | 'clinic' | 'maintenance' | 'wet' | 'league' | 'other'
  title?: string
  starts_at?: string  // ISO datetime
  ends_at?: string    // ISO datetime
  device_id: string
  device_type: string
  initiated_by?: 'user' | 'ai_assistant'
}

// Denial codes for expected business rule failures (HTTP 200)
type DenialCode =
  | 'MISSING_BLOCK_ID'
  | 'MISSING_DEVICE_ID'
  | 'DEVICE_NOT_REGISTERED'
  | 'UNAUTHORIZED'
  | 'BLOCK_NOT_FOUND'
  | 'BLOCK_CANCELLED'
  | 'BLOCK_IN_PAST'
  | 'CANNOT_CHANGE_WET_TYPE'
  | 'INVALID_DATE_RANGE'
  | 'INVALID_BLOCK_TYPE'
  | 'COURT_NOT_FOUND'
  | 'NO_CHANGES'

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

  let requestData: UpdateBlockRequest | null = null

  try {
    requestData = await req.json() as UpdateBlockRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.block_id) {
      return denialResponse('MISSING_BLOCK_ID', 'block_id is required', serverNow)
    }
    if (!requestData.device_id) {
      return denialResponse('MISSING_DEVICE_ID', 'device_id is required', serverNow)
    }

    // Validate block_type if provided
    if (requestData.block_type && !['lesson', 'clinic', 'maintenance', 'wet', 'league', 'other'].includes(requestData.block_type)) {
      return denialResponse('INVALID_BLOCK_TYPE', 'block_type must be "lesson", "clinic", "maintenance", "wet", "league", or "other"', serverNow)
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
          action: 'block_update_unauthorized',
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

      return forbiddenResponse('Admin access required to update court blocks', serverNow)
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
      return denialResponse('BLOCK_NOT_FOUND', 'Block not found', serverNow)
    }

    if (block.cancelled_at) {
      return denialResponse('BLOCK_CANCELLED', 'Block has been cancelled', serverNow)
    }

    // Check if block is in the past
    const blockEndsAt = new Date(block.ends_at)
    if (blockEndsAt < new Date()) {
      return denialResponse('BLOCK_IN_PAST', 'Cannot edit past blocks', serverNow)
    }

    // ===========================================
    // VALIDATE WET BLOCK TYPE CHANGE
    // ===========================================

    if (block.block_type === 'wet' && requestData.block_type && requestData.block_type !== 'wet') {
      return denialResponse('CANNOT_CHANGE_WET_TYPE', 'Cannot change type of wet blocks', serverNow)
    }

    // ===========================================
    // VALIDATE DATE RANGE IF PROVIDED
    // ===========================================

    const newStartsAt = requestData.starts_at ? new Date(requestData.starts_at) : new Date(block.starts_at)
    const newEndsAt = requestData.ends_at ? new Date(requestData.ends_at) : new Date(block.ends_at)

    if (newEndsAt <= newStartsAt) {
      return denialResponse('INVALID_DATE_RANGE', 'ends_at must be after starts_at', serverNow)
    }

    // ===========================================
    // VALIDATE COURT IF PROVIDED
    // ===========================================

    let newCourtNumber = block.courts?.court_number
    let newCourtName = block.courts?.name

    if (requestData.court_id && requestData.court_id !== block.court_id) {
      const { data: newCourt, error: courtError } = await supabase
        .from('courts')
        .select('id, court_number, name')
        .eq('id', requestData.court_id)
        .single()

      if (courtError || !newCourt) {
        return denialResponse('COURT_NOT_FOUND', 'Court not found', serverNow)
      }

      newCourtNumber = newCourt.court_number
      newCourtName = newCourt.name
    }

    // ===========================================
    // BUILD UPDATE PATCH
    // ===========================================

    const updatePatch: Record<string, unknown> = {}

    if (requestData.court_id !== undefined) {
      updatePatch.court_id = requestData.court_id
    }
    if (requestData.block_type !== undefined) {
      updatePatch.block_type = requestData.block_type
    }
    if (requestData.title !== undefined) {
      updatePatch.title = requestData.title.trim()
    }
    if (requestData.starts_at !== undefined) {
      updatePatch.starts_at = requestData.starts_at
    }
    if (requestData.ends_at !== undefined) {
      updatePatch.ends_at = requestData.ends_at
    }

    // Check if there are any changes
    if (Object.keys(updatePatch).length === 0) {
      return denialResponse('NO_CHANGES', 'No changes provided', serverNow)
    }

    // ===========================================
    // UPDATE THE BLOCK
    // ===========================================

    const { data: updatedBlock, error: updateError } = await supabase
      .from('blocks')
      .update(updatePatch)
      .eq('id', requestData.block_id)
      .select('*')
      .single()

    if (updateError) {
      console.error('Failed to update block:', updateError)
      return internalErrorResponse(`Failed to update block: ${updateError.message}`, serverNow)
    }

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'block_update',
        entity_type: 'block',
        entity_id: updatedBlock.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        request_data: {
          block_id: requestData.block_id,
          changes: updatePatch,
          previous: {
            court_id: block.court_id,
            block_type: block.block_type,
            title: block.title,
            starts_at: block.starts_at,
            ends_at: block.ends_at,
          },
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    // Insert board change signal for real-time updates
    await signalBoardChange(supabase, 'block')

    // Calculate duration in minutes
    const durationMinutes = Math.round((newEndsAt.getTime() - newStartsAt.getTime()) / 60000)

    return successResponse({
      block: {
        id: updatedBlock.id,
        court_id: updatedBlock.court_id,
        court_number: newCourtNumber,
        court_name: newCourtName,
        block_type: updatedBlock.block_type,
        title: updatedBlock.title,
        starts_at: updatedBlock.starts_at,
        ends_at: updatedBlock.ends_at,
        duration_minutes: durationMinutes,
        is_recurring: updatedBlock.is_recurring,
        recurrence_rule: updatedBlock.recurrence_rule,
      },
    }, serverNow)

  } catch (error) {
    // Audit log - failure
    await supabase
      .from('audit_log')
      .insert({
        action: 'block_update',
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

    console.error('Unexpected error in update-block:', error)
    return internalErrorResponse(error.message, serverNow)
  }
})
