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
  errorResponse,
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

    // Validate admin access - only admin and kiosk devices can clear waitlist
    if (device_type !== 'admin' && device_type !== 'kiosk') {
      console.warn(
        `[clear-waitlist] UNAUTHORIZED attempt by ${device_type || 'unknown'}:${device_id || 'unknown'}`
      );
      return addCorsHeaders(
        errorResponse('UNAUTHORIZED', 'Admin access required to clear waitlist', serverNow, 403)
      );
    }

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

    // Audit log the admin action with context
    const auditContext = {
      action: 'clear_waitlist',
      device_id: device_id || 'unknown',
      device_type: device_type || 'unknown',
      entries_cancelled: waitingEntries.length,
      entry_ids: waitingEntries.map((e: { id: string }) => e.id),
      timestamp: serverNow,
    };
    console.log(`[clear-waitlist] SUCCESS:`, JSON.stringify(auditContext));

    // Write to audit_log table for persistent tracking
    await supabase.from('audit_log').insert({
      action: 'clear_waitlist',
      actor_device_id: device_id,
      actor_device_type: device_type,
      details: {
        entries_cancelled: waitingEntries.length,
        entry_ids: waitingEntries.map((e: { id: string }) => e.id),
      },
      created_at: serverNow,
    });

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
