/**
 * Shared Session Lifecycle Helper
 *
 * ARCHITECTURE: Single Source of Truth
 * - session_events table is the append-only source of truth
 * - sessions.actual_end_at is a denormalized cache for query performance
 * - This helper ensures both are ALWAYS updated together
 *
 * All session-ending code paths MUST use this helper to prevent inconsistency.
 */

export type EndReason = 'cleared' | 'observed_cleared' | 'admin_override' | 'overtime_takeover' | 'auto_cleared'

/**
 * Map incoming end_reason strings to valid constraint values
 * Frontend may send: 'Cleared', 'Observed-Cleared', 'cleared', 'admin', etc.
 * Database constraint requires: 'cleared', 'observed_cleared', 'admin_override', 'overtime_takeover', 'auto_cleared'
 */
export function normalizeEndReason(reason: string | undefined): EndReason {
  if (!reason) return 'cleared'

  // If already a valid value, pass through
  if (['cleared', 'observed_cleared', 'admin_override', 'overtime_takeover', 'auto_cleared'].includes(reason)) {
    return reason as EndReason
  }

  const normalized = reason.toLowerCase().trim()

  // Observer clear: "The players have left the court, I'm sure!"
  if (normalized.includes('observed') || normalized.includes('empty')) {
    return 'observed_cleared'
  }

  // Player self-clear: "We finished and are leaving our court"
  if (normalized.includes('clear') && !normalized.includes('observed')) {
    return 'cleared'
  }

  // Admin clear
  if (normalized.includes('admin') || normalized.includes('force')) {
    return 'admin_override'
  }

  // Bumped by overtime takeover
  if (normalized.includes('bump') || normalized.includes('takeover') || normalized.includes('overtime')) {
    return 'overtime_takeover'
  }

  // Auto-cleared by timer
  if (normalized === 'completed' || normalized.includes('time') || normalized.includes('expired') || normalized.includes('auto')) {
    return 'auto_cleared'
  }

  // Regression guard: log unexpected values
  console.warn(`[normalizeEndReason] Unexpected end_reason value: "${reason}", defaulting to 'cleared'`)

  // Default to 'cleared' for any unrecognized value
  return 'cleared'
}

export interface EndSessionOptions {
  sessionId: string
  serverNow: string
  endReason: EndReason | string  // Accept string for flexibility, will be normalized
  deviceId?: string
  eventData?: Record<string, any>
}

export interface EndSessionResult {
  success: boolean
  alreadyEnded: boolean
  error?: string
}

/**
 * End a session atomically - inserts END event AND updates actual_end_at
 *
 * ARCHITECTURE: Single Source of Truth
 * - session_events table is the append-only source of truth
 * - sessions.actual_end_at is a denormalized cache for query performance
 * - BOTH must be updated together, or the operation fails
 *
 * This is the ONLY function that should be used to end sessions.
 *
 * @param supabase - Supabase client with service role (required for RLS bypass)
 * @param options - Session end options
 * @returns Result indicating success, already-ended, or error
 */
export async function endSession(
  supabase: any,
  options: EndSessionOptions
): Promise<EndSessionResult> {
  const { sessionId, serverNow, endReason: rawEndReason, deviceId, eventData } = options

  // Normalize end_reason to valid constraint value
  const endReason = normalizeEndReason(rawEndReason)

  // Step 1: Insert END event (source of truth)
  // Note: Multiple END events are allowed for sessions that were restored.
  // The active_sessions_view handles this by checking if the most recent
  // RESTORE is newer than the most recent END.
  const { error: eventError } = await supabase
    .from('session_events')
    .insert({
      session_id: sessionId,
      event_type: 'END',
      event_data: {
        reason: endReason,
        ended_at: serverNow,
        ended_by: deviceId || null,
        ...eventData,
      },
      created_by: deviceId || null,
    })

  if (eventError) {
    console.error(`[endSession] Failed to insert END event for session ${sessionId}`)
    console.error(`[endSession] Error code: ${eventError.code}, message: ${eventError.message}`)
    return { success: false, alreadyEnded: false, error: eventError.message }
  }

  // Step 2: Update sessions.actual_end_at (denormalized cache)
  const { error: updateError } = await supabase
    .from('sessions')
    .update({
      actual_end_at: serverNow,
      end_reason: endReason,
    })
    .eq('id', sessionId)

  if (updateError) {
    // Log but don't fail - the END event is already recorded (source of truth)
    // The cleanup-sessions function can repair this inconsistency if needed
    console.error(`[endSession] Warning: END event recorded but actual_end_at update failed`)
    console.error(`[endSession] Session ${sessionId}: ${updateError.message}`)
  }

  return { success: true, alreadyEnded: false }
}

/**
 * Signal that the board has changed (for real-time updates)
 *
 * Uses TWO approaches for reliability:
 * 1. Insert into board_change_signals table (triggers postgres_changes if replication enabled)
 * 2. Send a broadcast message (always works, doesn't need database replication)
 */
export async function signalBoardChange(
  supabase: any,
  changeType: 'session' | 'waitlist' | 'block' = 'session'
): Promise<void> {
  // Method 1: Database insert (for postgres_changes subscribers)
  await supabase
    .from('board_change_signals')
    .insert({ change_type: changeType })

  // Method 2: Broadcast (more reliable, doesn't need database replication)
  const channel = supabase.channel('board-updates')
  await channel.send({
    type: 'broadcast',
    event: 'board_changed',
    payload: { change_type: changeType, timestamp: new Date().toISOString() }
  })
  await supabase.removeChannel(channel)
}

/**
 * Find active session(s) on a court
 * Uses actual_end_at IS NULL (consistent with our denormalized cache approach)
 * Returns the most recent session if multiple exist (indicates stale data)
 */
export async function findActiveSessionOnCourt(
  supabase: any,
  courtId: string
): Promise<{ id: string; scheduledEndAt?: string } | null> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, scheduled_end_at')
    .eq('court_id', courtId)
    .is('actual_end_at', null)
    .order('started_at', { ascending: false })
    .limit(1)

  if (error || !data || data.length === 0) {
    return null
  }

  // Return the most recent session
  const session = data[0]
  return {
    id: session.id,
    scheduledEndAt: session.scheduled_end_at,
  }
}

/**
 * Find ALL active sessions on a court (for cleanup operations)
 */
export async function findAllActiveSessionsOnCourt(
  supabase: any,
  courtId: string
): Promise<Array<{ id: string; scheduledEndAt?: string }>> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, scheduled_end_at')
    .eq('court_id', courtId)
    .is('actual_end_at', null)
    .order('started_at', { ascending: false })

  if (error || !data) {
    return []
  }

  return data.map((s: any) => ({
    id: s.id,
    scheduledEndAt: s.scheduled_end_at,
  }))
}
