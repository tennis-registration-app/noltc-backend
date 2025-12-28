/**
 * Move Court — Atomically move an active session from one court to another
 *
 * POST /move-court
 * Body: { from_court_id, to_court_id, device_id?, device_type? }
 *
 * Server behavior:
 * 1. Validate from_court has active session
 * 2. Validate to_court is available (not occupied, not blocked)
 * 3. Move session atomically (update court_id on session)
 * 4. Signal board change for real-time updates
 * 5. Return success with updated session info
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
    const { from_court_id, to_court_id, device_id, device_type } = body;

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

    // Get the active session on from_court
    const { data: fromSession, error: fromError } = await supabase
      .from('sessions')
      .select('id, court_id, started_at, scheduled_end_at, session_type')
      .eq('court_id', resolvedFromCourtId)
      .is('actual_end_at', null)
      .single();

    if (fromError || !fromSession) {
      return addCorsHeaders(
        notFoundResponse('No active session found on source court', serverNow)
      );
    }

    // Check for active session on to_court
    const { data: toSession } = await supabase
      .from('sessions')
      .select('id')
      .eq('court_id', resolvedToCourtId)
      .is('actual_end_at', null)
      .single();

    if (toSession) {
      return addCorsHeaders(
        conflictResponse(
          'DESTINATION_OCCUPIED',
          'Destination court already has an active session',
          serverNow
        )
      );
    }

    // Check for active blocks on to_court
    const { data: toBlock } = await supabase
      .from('court_blocks')
      .select('id')
      .eq('court_id', resolvedToCourtId)
      .lte('starts_at', serverNow)
      .gte('ends_at', serverNow)
      .single();

    if (toBlock) {
      return addCorsHeaders(
        conflictResponse('DESTINATION_BLOCKED', 'Destination court is currently blocked', serverNow)
      );
    }

    // Atomically move the session by updating court_id
    const { error: updateError } = await supabase
      .from('sessions')
      .update({ court_id: resolvedToCourtId })
      .eq('id', fromSession.id);

    if (updateError) {
      console.error('Failed to move session:', updateError);
      return addCorsHeaders(internalErrorResponse('Failed to move session', serverNow));
    }

    // Log the move action
    console.log(
      `[move-court] Session ${fromSession.id} moved from ${resolvedFromCourtId} to ${resolvedToCourtId} by ${device_type || 'unknown'}:${device_id || 'unknown'}`
    );

    // Signal board change for real-time updates
    await signalBoardChange(supabase, 'session');

    return addCorsHeaders(
      successResponse(
        {
          message: 'Session moved successfully',
          sessionId: fromSession.id,
          fromCourtId: resolvedFromCourtId,
          toCourtId: resolvedToCourtId,
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
