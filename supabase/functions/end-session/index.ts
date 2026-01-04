import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  endSession,
  signalBoardChange,
  findAllActiveSessionsOnCourt,
} from '../_shared/sessionLifecycle.ts';
import {
  END_REASONS,
  isValidEndReason,
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
    const { session_id, court_id, end_reason, device_id } = body;

    // Validate: need either session_id or court_id
    if (!session_id && !court_id) {
      return addCorsHeaders(
        errorResponse('MISSING_IDENTIFIER', 'Either session_id or court_id is required', serverNow)
      );
    }

    // Validate end_reason if provided
    const resolvedEndReason = end_reason || 'cleared';
    if (!isValidEndReason(resolvedEndReason)) {
      return addCorsHeaders(
        errorResponse(
          'INVALID_END_REASON',
          `end_reason must be one of: ${END_REASONS.join(', ')}`,
          serverNow
        )
      );
    }

    let targetSessionId = session_id;
    let resolvedCourtId = court_id;

    // If court_id provided, find the active session for that court
    if (!targetSessionId && court_id) {
      // Determine if court_id is a UUID or a court number
      const isUUID = typeof court_id === 'string' && court_id.includes('-');

      if (isUUID) {
        // court_id is already a UUID
        resolvedCourtId = court_id;
      } else {
        // court_id is a court number, look up the UUID
        const courtNumber = parseInt(court_id, 10);
        if (isNaN(courtNumber)) {
          return addCorsHeaders(
            errorResponse('INVALID_COURT_ID', `Invalid court_id: ${court_id}`, serverNow)
          );
        }

        const { data: courtData, error: courtError } = await supabase
          .from('courts')
          .select('id')
          .eq('court_number', courtNumber)
          .single();

        if (courtError || !courtData) {
          return addCorsHeaders(notFoundResponse(`Court ${courtNumber} not found`, serverNow));
        }

        resolvedCourtId = courtData.id;
      }

      // Find ALL active sessions on this court (handles stale data)
      const activeSessions = await findAllActiveSessionsOnCourt(supabase, resolvedCourtId);

      if (!activeSessions || activeSessions.length === 0) {
        return addCorsHeaders(
          notFoundResponse(`No active session found on court ${court_id}`, serverNow)
        );
      }

      // Log if multiple sessions found (indicates stale data issue)
      if (activeSessions.length > 1) {
        console.warn(
          `⚠️ Found ${activeSessions.length} active sessions on court ${resolvedCourtId} - ending all`
        );
      }

      // End ALL sessions on this court
      let sessionsEnded = 0;
      let cacheFailures: string[] = [];
      for (const session of activeSessions) {
        const result = await endSession(supabase, {
          sessionId: session.id,
          serverNow,
          endReason: resolvedEndReason,
          deviceId: device_id,
        });
        if (result.success || result.alreadyEnded) {
          sessionsEnded++;
        }
        if (result.cacheOk === false) {
          cacheFailures.push(session.id);
          console.error(`[end-session] ⚠️ Cache inconsistency for session ${session.id}: ${result.cacheError}`);
        }
      }

      console.log(`Ended ${sessionsEnded}/${activeSessions.length} sessions on court ${resolvedCourtId}`);
      if (cacheFailures.length > 0) {
        console.error(`[end-session] ⚠️ ${cacheFailures.length} session(s) have stale cache - needs repair`);
      }

      // Signal board change
      await signalBoardChange(supabase, 'session');

      return addCorsHeaders(
        successResponse(
          {
            sessionsEnded,
            message: sessionsEnded > 1 ? `Ended ${sessionsEnded} sessions` : 'Session ended',
            cacheOk: cacheFailures.length === 0,
            ...(cacheFailures.length > 0 && { cacheFailures }),
          },
          serverNow
        )
      );
    }

    // If session_id was provided directly, end just that session
    const result = await endSession(supabase, {
      sessionId: targetSessionId,
      serverNow,
      endReason: resolvedEndReason,
      deviceId: device_id,
    });

    if (result.alreadyEnded) {
      return addCorsHeaders(
        conflictResponse('SESSION_ALREADY_ENDED', 'This session has already been ended', serverNow)
      );
    }

    if (!result.success) {
      return addCorsHeaders(
        internalErrorResponse(result.error || 'Failed to end session', serverNow)
      );
    }

    // Log cache inconsistency if present
    if (result.cacheOk === false) {
      console.error(`[end-session] ⚠️ Cache inconsistency for session ${targetSessionId}: ${result.cacheError}`);
    }

    // Signal board change for real-time updates
    await signalBoardChange(supabase, 'session');

    // Get session details for response
    const { data: session } = await supabase
      .from('sessions')
      .select('id, court_id, started_at, session_type')
      .eq('id', targetSessionId)
      .single();

    return addCorsHeaders(
      successResponse(
        {
          session: session
            ? {
                id: session.id,
                courtId: session.court_id,
                startedAt: session.started_at,
                endedAt: serverNow,
                sessionType: session.session_type,
              }
            : null,
          cacheOk: result.cacheOk !== false,
          ...(result.cacheOk === false && { cacheError: result.cacheError }),
        },
        serverNow
      )
    );
  } catch (error) {
    console.error('Unexpected error:', error);
    return addCorsHeaders(internalErrorResponse(error.message, serverNow));
  }
});

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
