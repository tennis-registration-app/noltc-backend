import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  WAITLIST_STATUSES,
  successResponse,
  errorResponse,
  notFoundResponse,
  conflictResponse,
  internalErrorResponse,
} from '../_shared/index.ts';
import { signalBoardChange } from "../_shared/sessionLifecycle.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
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
    const { device_id, waitlist_entry_id, reason } = body;

    // Validate required fields
    if (!device_id) {
      return addCorsHeaders(errorResponse('MISSING_DEVICE', 'device_id is required', serverNow));
    }

    if (!waitlist_entry_id) {
      return addCorsHeaders(
        errorResponse('MISSING_WAITLIST_ENTRY', 'waitlist_entry_id is required', serverNow)
      );
    }

    // Verify admin device
    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('id, device_type, is_active')
      .eq('id', device_id)
      .single();

    if (deviceError || !device) {
      return addCorsHeaders(errorResponse('INVALID_DEVICE', 'Device not found', serverNow, 401));
    }

    if (!device.is_active) {
      return addCorsHeaders(
        errorResponse('DEVICE_INACTIVE', 'Device is not active', serverNow, 401)
      );
    }

    // Check admin authorization
    if (device.device_type !== 'admin') {
      await supabase.from('audit_log').insert({
        action: 'remove_from_waitlist_unauthorized',
        entity_type: 'waitlist',
        entity_id: waitlist_entry_id,
        device_id: device.id,
        device_type: device.device_type,
        request_data: { waitlist_entry_id, reason },
        outcome: 'denied',
        error_message: 'Admin access required',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      });

      return addCorsHeaders(
        errorResponse('UNAUTHORIZED', 'Admin access required', serverNow, 403)
      );
    }

    // Get waitlist entry details before removal
    console.log('[remove-from-waitlist] Looking up waitlist entry:', waitlist_entry_id);
    const { data: entry, error: entryError } = await supabase
      .from('waitlist')
      .select(
        `
        id,
        status,
        group_type,
        created_at,
        waitlist_members (
          member_id,
          guest_name
        )
      `
      )
      .eq('id', waitlist_entry_id)
      .single();

    console.log('[remove-from-waitlist] Query result:', { entry, entryError });

    if (entryError || !entry) {
      console.error('[remove-from-waitlist] Entry not found. Error:', entryError);
      return addCorsHeaders(notFoundResponse('Waitlist entry not found', serverNow));
    }

    // Use WAITLIST_STATUSES constant for status check
    if (entry.status !== WAITLIST_STATUSES[0]) {
      // 'waiting'
      return addCorsHeaders(
        conflictResponse(
          'ENTRY_NOT_ACTIVE',
          `Waitlist entry is not active (status: ${entry.status})`,
          serverNow
        )
      );
    }

    // Update waitlist entry status to cancelled (admin removed)
    const { error: updateError } = await supabase
      .from('waitlist')
      .update({
        status: WAITLIST_STATUSES[2], // 'cancelled'
      })
      .eq('id', waitlist_entry_id);

    if (updateError) {
      throw updateError;
    }

    // Insert board change signal
    await signalBoardChange(supabase, 'waitlist');

    // Audit log
    await supabase.from('audit_log').insert({
      action: 'remove_from_waitlist',
      entity_type: 'waitlist',
      entity_id: waitlist_entry_id,
      device_id: device.id,
      device_type: device.device_type,
      request_data: {
        waitlist_entry_id,
        reason: reason || 'admin_removed',
        group_type: entry.group_type,
        participants: entry.waitlist_members,
      },
      outcome: 'success',
      ip_address: req.headers.get('x-forwarded-for') || 'unknown',
    });

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
        console.error('Failed to fetch board after remove-from-waitlist:', courtsResult.error);
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
      console.error('Failed to fetch board after remove-from-waitlist:', boardError);
    }

    return addCorsHeaders(
      successResponse(
        {
          message: 'Removed from waitlist',
          waitlistEntryId: waitlist_entry_id,
          board,
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
