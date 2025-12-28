/**
 * Clear Waitlist — Cancel all entries on the waitlist (admin action)
 *
 * POST /clear-waitlist
 * Body: { device_id?, device_type? }
 *
 * Server behavior:
 * 1. Get all waiting entries
 * 2. Cancel all entries atomically
 * 3. Signal board change for real-time updates
 * 4. Return count of cancelled entries
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { signalBoardChange } from '../_shared/sessionLifecycle.ts';
import {
  successResponse,
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
    const { device_id, device_type } = body;

    // Get count of waiting entries first
    const { data: waitingEntries, error: fetchError } = await supabase
      .from('waitlist')
      .select('id')
      .eq('status', 'waiting');

    if (fetchError) {
      console.error('Failed to fetch waitlist:', fetchError);
      return addCorsHeaders(internalErrorResponse('Failed to fetch waitlist', serverNow));
    }

    if (!waitingEntries || waitingEntries.length === 0) {
      return addCorsHeaders(
        successResponse(
          {
            message: 'Waitlist is already empty',
            cancelledCount: 0,
          },
          serverNow
        )
      );
    }

    // Cancel all entries atomically
    const { error: updateError } = await supabase
      .from('waitlist')
      .update({
        status: 'cancelled',
        cancelled_at: serverNow,
      })
      .eq('status', 'waiting');

    if (updateError) {
      console.error('Failed to clear waitlist:', updateError);
      return addCorsHeaders(internalErrorResponse('Failed to clear waitlist', serverNow));
    }

    // Log the action
    console.log(
      `[clear-waitlist] Cancelled ${waitingEntries.length} entries by ${device_type || 'unknown'}:${device_id || 'unknown'}`
    );

    // Signal board change for real-time updates
    await signalBoardChange(supabase, 'waitlist');

    return addCorsHeaders(
      successResponse(
        {
          message: 'Waitlist cleared successfully',
          cancelledCount: waitingEntries.length,
        },
        serverNow
      )
    );
  } catch (error) {
    console.error('clear-waitlist error:', error);
    return addCorsHeaders(internalErrorResponse(error.message || 'Internal server error', serverNow));
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
