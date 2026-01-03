// supabase/functions/get-board/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { successResponse, errorResponse, internalErrorResponse } from '../_shared/index.ts';

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
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get court board using the exact same timestamp
    const { data: courts, error: courtsError } = await supabase.rpc('get_court_board', {
      request_time: serverNow,
    });

    if (courtsError) {
      console.error('Courts query error:', courtsError);
      return addCorsHeaders(errorResponse('QUERY_ERROR', 'Failed to load courts', serverNow, 500));
    }

    // Get active waitlist using the same timestamp
    const { data: waitlist, error: waitlistError } = await supabase.rpc('get_active_waitlist', {
      request_time: serverNow,
    });

    if (waitlistError) {
      console.error('Waitlist query error:', waitlistError);
      return addCorsHeaders(
        errorResponse('QUERY_ERROR', 'Failed to load waitlist', serverNow, 500)
      );
    }

    // Get upcoming blocks for today (not yet started, but scheduled for today)
    const { data: upcomingBlocks, error: upcomingBlocksError } = await supabase.rpc(
      'get_upcoming_blocks',
      {
        request_time: serverNow,
      }
    );

    if (upcomingBlocksError) {
      console.error('Upcoming blocks query error:', upcomingBlocksError);
      // Non-fatal: continue without upcoming blocks
    }

    // Get operating hours
    const { data: operatingHours } = await supabase
      .from('operating_hours')
      .select('*')
      .order('day_of_week');

    // Transform upcoming blocks to camelCase for frontend
    const transformedUpcomingBlocks = (upcomingBlocks || []).map((b: any) => ({
      id: b.block_id,
      courtId: b.court_id,
      courtNumber: b.court_number,
      blockType: b.block_type,
      title: b.title,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
    }));

    return addCorsHeaders(
      successResponse(
        {
          courts: courts || [],
          waitlist: waitlist || [],
          operatingHours: operatingHours || [],
          upcomingBlocks: transformedUpcomingBlocks,
        },
        serverNow
      )
    );
  } catch (error) {
    console.error('Unexpected error:', error);
    return addCorsHeaders(internalErrorResponse('An unexpected error occurred', serverNow));
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
