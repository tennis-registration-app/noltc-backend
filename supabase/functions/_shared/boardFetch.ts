/**
 * Board state fetch helper for Edge Functions
 *
 * Fetches the full board snapshot (courts, waitlist, upcoming blocks, operating hours)
 * so the frontend can apply it without a separate refetch after a mutating operation.
 * Board fetch is non-fatal — errors are logged and null is returned on failure.
 */

/**
 * Fetch the current board state from the four board RPCs/queries.
 *
 * @param supabase - Supabase client with service role
 * @param callerName - Name of the calling function, used in error log messages
 * @returns The board snapshot object, or null if the fetch fails
 */
export async function fetchBoardState(
  supabase: any,
  callerName: string
): Promise<Record<string, unknown> | null> {
  try {
    const boardNow = new Date().toISOString();
    const [courtsResult, waitlistResult, upcomingResult, hoursResult] = await Promise.all([
      supabase.rpc('get_court_board', { request_time: boardNow }),
      supabase.rpc('get_active_waitlist', { request_time: boardNow }),
      supabase.rpc('get_upcoming_blocks', { request_time: boardNow }),
      supabase.from('operating_hours').select('*').order('day_of_week'),
    ]);

    if (courtsResult.error) {
      console.error(`Failed to fetch board after ${callerName}:`, courtsResult.error);
      return null;
    }

    const upcomingBlocks = (upcomingResult.data || []).map((b: any) => ({
      id: b.block_id,
      courtId: b.court_id,
      courtNumber: b.court_number,
      blockType: b.block_type,
      title: b.title,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
    }));

    return {
      serverNow: boardNow,
      courts: courtsResult.data || [],
      waitlist: waitlistResult.data || [],
      operatingHours: hoursResult.data || [],
      upcomingBlocks,
    };
  } catch (boardError) {
    console.error(`Failed to fetch board after ${callerName}:`, boardError);
    return null;
  }
}
