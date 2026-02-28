/**
 * Move Court — Atomically move an active session from one court to another
 *
 * POST /move-court
 * Body: { from_court_id, to_court_id, device_id }
 *
 * Server behavior:
 * 1. Verify device against registry (admin/kiosk only)
 * 2. Validate from_court has active session
 * 3. Validate to_court is available (not occupied, not blocked)
 * 4. Move session atomically (update court_id on session)
 * 5. Audit log all attempts (success/failure/denied)
 * 6. Signal board change for real-time updates
 * 7. Return success with updated session info
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { signalBoardChange } from '../_shared/sessionLifecycle.ts';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  conflictResponse,
  internalErrorResponse,
} from '../_shared/index.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const serverNow = new Date().toISOString();

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const body = await req.json();
    const { from_court_id, to_court_id, device_id } = body;

    // Require device_id
    if (!device_id) {
      return addCorsHeaders(
        errorResponse('BAD_REQUEST', 'device_id is required', serverNow, 400)
      );
    }

    // Verify device against registry (don't trust client-provided device_type)
    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('id, device_type, is_active')
      .eq('id', device_id)
      .single();

    if (deviceError || !device) {
      console.warn(`[move-court] UNAUTHORIZED: Unknown device ${device_id}`);
      await supabase.from('audit_log').insert({
        action: 'move_court',
        entity_type: 'session',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: device_id,
        outcome: 'denied',
        error_message: 'Unknown device',
        request_data: { from_court_id, to_court_id },
        created_at: serverNow,
      });
      return addCorsHeaders(
        errorResponse('UNAUTHORIZED', 'Unknown device', serverNow, 403)
      );
    }

    if (!device.is_active) {
      console.warn(`[move-court] UNAUTHORIZED: Inactive device ${device_id}`);
      await supabase.from('audit_log').insert({
        action: 'move_court',
        entity_type: 'session',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: device_id,
        device_type: device.device_type,
        outcome: 'denied',
        error_message: 'Device is inactive',
        request_data: { from_court_id, to_court_id },
        created_at: serverNow,
      });
      return addCorsHeaders(
        errorResponse('UNAUTHORIZED', 'Device is inactive', serverNow, 403)
      );
    }

    // Validate admin access - only admin and kiosk devices can move courts
    if (device.device_type !== 'admin' && device.device_type !== 'kiosk') {
      console.warn(
        `[move-court] UNAUTHORIZED: Device ${device_id} is ${device.device_type}, not admin`
      );
      await supabase.from('audit_log').insert({
        action: 'move_court',
        entity_type: 'session',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: device_id,
        device_type: device.device_type,
        outcome: 'denied',
        error_message: `Device type ${device.device_type} not authorized`,
        request_data: { from_court_id, to_court_id },
        created_at: serverNow,
      });
      return addCorsHeaders(
        errorResponse('UNAUTHORIZED', 'Admin access required', serverNow, 403)
      );
    }

    // Validate required fields
    if (!from_court_id) {
      return addCorsHeaders(
        errorResponse('MISSING_FROM_COURT', 'from_court_id is required', serverNow)
      );
    }
    if (!to_court_id) {
      return addCorsHeaders(
        errorResponse('MISSING_TO_COURT', 'to_court_id is required', serverNow)
      );
    }
    if (from_court_id === to_court_id) {
      return addCorsHeaders(
        errorResponse('SAME_COURT', 'from_court_id and to_court_id must be different', serverNow)
      );
    }

    // Resolve court IDs (may be UUIDs or court numbers)
    const resolvedFromCourtId = await resolveCourtId(supabase, from_court_id);
    if (!resolvedFromCourtId) {
      return addCorsHeaders(
        notFoundResponse(`Source court not found: ${from_court_id}`, serverNow)
      );
    }

    const resolvedToCourtId = await resolveCourtId(supabase, to_court_id);
    if (!resolvedToCourtId) {
      return addCorsHeaders(
        notFoundResponse(`Destination court not found: ${to_court_id}`, serverNow)
      );
    }

    // Use atomic RPC function with row-level locking
    const { data: result, error: rpcError } = await supabase.rpc('move_court_atomic', {
      p_from_court_id: resolvedFromCourtId,
      p_to_court_id: resolvedToCourtId,
    });

    if (rpcError) {
      console.error('RPC error:', rpcError);
      return addCorsHeaders(internalErrorResponse('Database operation failed', serverNow));
    }

    if (!result.ok) {
      // Log the rejection
      console.log(
        `[move-court] Rejected: ${result.code} - ${result.message} (${device.device_type}:${device.id})`
      );

      // Audit log the failure
      await supabase.from('audit_log').insert({
        action: 'move_court',
        entity_type: 'session',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: device.id,
        device_type: device.device_type,
        outcome: 'failure',
        error_message: `${result.code}: ${result.message}`,
        request_data: { from_court_id, to_court_id },
        created_at: serverNow,
      });

      if (result.code === 'NO_ACTIVE_SESSION') {
        return addCorsHeaders(notFoundResponse(result.message, serverNow));
      }
      return addCorsHeaders(conflictResponse(result.code, result.message, serverNow));
    }

    // Log the successful move
    console.log(
      `[move-court] Session ${result.sessionId} moved from ${result.fromCourtId} to ${result.toCourtId} by ${device.device_type}:${device.id}`
    );

    // Audit log the success
    await supabase.from('audit_log').insert({
      action: 'move_court',
      entity_type: 'session',
      entity_id: result.sessionId,
      device_id: device.id,
      device_type: device.device_type,
      outcome: 'success',
      request_data: {
        from_court_id: result.fromCourtId,
        to_court_id: result.toCourtId,
      },
      created_at: serverNow,
    });

    // Signal board change for real-time updates
    await signalBoardChange(supabase, 'session');

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
        console.error('Failed to fetch board after move:', courtsResult.error);
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
      console.error('Failed to fetch board after move:', boardError);
      // Don't fail the whole operation — move succeeded
    }

    return addCorsHeaders(
      successResponse(
        {
          message: 'Session moved successfully',
          sessionId: result.sessionId,
          fromCourtId: result.fromCourtId,
          toCourtId: result.toCourtId,
          board,
        },
        serverNow
      )
    );
  } catch (error) {
    console.error('move-court error:', error);
    return addCorsHeaders(internalErrorResponse(error.message || 'Internal server error', serverNow));
  }
});

/**
 * Resolve a court identifier to a UUID
 * Accepts either a UUID or a court number (1-12)
 */
async function resolveCourtId(
  supabase: ReturnType<typeof createClient>,
  courtId: string | number
): Promise<string | null> {
  // Check if it's already a UUID
  const isUUID = typeof courtId === 'string' && courtId.includes('-');
  if (isUUID) {
    // Verify the court exists
    const { data } = await supabase.from('courts').select('id').eq('id', courtId).single();
    return data?.id || null;
  }

  // It's a court number, look up the UUID
  const courtNumber = parseInt(String(courtId), 10);
  if (isNaN(courtNumber)) {
    return null;
  }

  const { data } = await supabase
    .from('courts')
    .select('id')
    .eq('court_number', courtNumber)
    .single();

  return data?.id || null;
}

/**
 * Add CORS headers to a response
 */
function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
