import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"

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

// Denial codes for expected business rule failures (HTTP 200)
type DenialCode =
  | 'MISSING_BLOCK_ID'
  | 'MISSING_DEVICE_ID'
  | 'DEVICE_NOT_REGISTERED'
  | 'BLOCK_NOT_FOUND'
  | 'ALREADY_CANCELLED'

/**
 * Standard success response with CORS
 */
function successResponse(data: Record<string, unknown>, serverNow: string, board?: Record<string, unknown> | null): Response {
  return new Response(JSON.stringify({
    ok: true,
    code: 'OK',
    message: '',
    serverNow,
    data,
    ...(board && { board }),
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

  let requestData: CancelBlockRequest | null = null

  try {
    requestData = await req.json() as CancelBlockRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.block_id) {
      return denialResponse('MISSING_BLOCK_ID', 'block_id is required', serverNow)
    }
    if (!requestData.device_id) {
      return denialResponse('MISSING_DEVICE_ID', 'device_id is required', serverNow)
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

      return forbiddenResponse('Admin access required to cancel court blocks', serverNow)
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
      return denialResponse('ALREADY_CANCELLED', 'Block is already cancelled', serverNow)
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
      console.error('Failed to cancel block:', updateError)
      return internalErrorResponse(`Failed to cancel block: ${updateError.message}`, serverNow)
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
    // ===========================================

    // Insert board change signal for real-time updates
    await signalBoardChange(supabase, 'block');

    // Fetch updated board state so frontend can apply without a separate refetch
    let board: Record<string, unknown> | null = null;
    try {
      const boardNow = new Date().toISOString();
      const [courtsResult, waitlistResult, upcomingResult, hoursResult] = await Promise.all([
        supabase.rpc('get_court_board', { request_time: boardNow }),
        supabase.rpc('get_active_waitlist', { request_time: boardNow }),
        supabase.rpc('get_upcoming_blocks', { request_time: boardNow }),
        supabase.from('operating_hours').select('*').order('day_of_week'),
      ]);

      if (courtsResult.error) {
        console.error('Failed to fetch board after cancel-block:', courtsResult.error);
      } else {
        const upcomingBlocks = (upcomingResult.data || []).map((b: any) => ({
          id: b.block_id,
          courtId: b.court_id,
          courtNumber: b.court_number,
          blockType: b.block_type,
          title: b.title,
          startsAt: b.starts_at,
          endsAt: b.ends_at,
        }));

        board = {
          serverNow: boardNow,
          courts: courtsResult.data || [],
          waitlist: waitlistResult.data || [],
          operatingHours: hoursResult.data || [],
          upcomingBlocks,
        };
      }
    } catch (boardError) {
      console.error('Failed to fetch board after cancel-block:', boardError);
    }

    return successResponse({
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
    }, serverNow, board)

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

    console.error('Unexpected error in cancel-block:', error)
    return internalErrorResponse(error.message, serverNow)
  }
})
