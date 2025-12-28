/**
 * Shared constants for Edge Functions
 *
 * Use these instead of hardcoded strings to prevent mismatches.
 */

export const END_REASONS = ['completed', 'cleared_early', 'admin_override'] as const;
export type EndReason = (typeof END_REASONS)[number];

export const WAITLIST_STATUSES = ['waiting', 'assigned', 'cancelled'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const GROUP_TYPES = ['singles', 'doubles', 'foursome'] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

export const COURT_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/**
 * Check if a value is a valid end reason
 */
export function isValidEndReason(value: unknown): value is EndReason {
  return typeof value === 'string' && END_REASONS.includes(value as EndReason);
}

/**
 * Check if a value is a valid waitlist status
 */
export function isValidWaitlistStatus(value: unknown): value is WaitlistStatus {
  return typeof value === 'string' && WAITLIST_STATUSES.includes(value as WaitlistStatus);
}

/**
 * Check if a value is a valid group type
 */
export function isValidGroupType(value: unknown): value is GroupType {
  return typeof value === 'string' && GROUP_TYPES.includes(value as GroupType);
}
