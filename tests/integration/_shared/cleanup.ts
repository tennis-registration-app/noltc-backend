/**
 * Shared cleanup helpers for integration tests.
 *
 * Every test file runs afterEach against a live shared Supabase DB. When a
 * cleanup silently fails mid-cascade (e.g. a session_events row still
 * references a session we're trying to delete), the next test's insert hits
 * a duplicate-key or FK error and fails for a reason that has nothing to do
 * with the code under test.
 *
 * These helpers:
 *   - Run the cascade in strict FK order.
 *   - Log (not throw) on per-step failures, so cleanup is best-effort and
 *     downstream steps still get a chance to run.
 *   - Count leftovers at the end and log a warning if any remain — so flakes
 *     are diagnosable from CI output alone.
 *
 * Callers should wrap their afterEach body in try/catch so the hook itself
 * never throws:
 *
 *   afterEach(async () => {
 *     try {
 *       await purgeSessionsForMembers(adminClient, [...], [...]);
 *     } catch (e) {
 *       console.error('afterEach cleanup failed:', e);
 *     }
 *   });
 */

type SupabaseAdmin = any;

function logStep(label: string, error: unknown): void {
  if (error) console.warn(`[cleanup] ${label} failed:`, error);
}

/**
 * Delete all sessions registered by any of `memberIds` plus any extra
 * `sessionIds` the caller tracks directly. Cascades through transactions,
 * session_events, session_participants.
 */
export async function purgeSessionsForMembers(
  admin: SupabaseAdmin,
  memberIds: string[],
  extraSessionIds: string[] = [],
): Promise<void> {
  let dynamicIds: string[] = [];
  if (memberIds.length > 0) {
    const { data, error } = await admin
      .from('sessions')
      .select('id')
      .in('registered_by_member_id', memberIds);
    logStep('select sessions by member', error);
    dynamicIds = (data ?? []).map((r: any) => r.id);
  }

  const sessionIds = Array.from(new Set([...dynamicIds, ...extraSessionIds]));
  if (sessionIds.length === 0) return;

  const { error: txErr } = await admin.from('transactions').delete().in('session_id', sessionIds);
  logStep('delete transactions', txErr);

  const { error: evErr } = await admin.from('session_events').delete().in('session_id', sessionIds);
  logStep('delete session_events', evErr);

  const { error: partErr } = await admin.from('session_participants').delete().in('session_id', sessionIds);
  logStep('delete session_participants', partErr);

  const { error: sessErr } = await admin.from('sessions').delete().in('id', sessionIds);
  logStep('delete sessions', sessErr);

  const { data: leftover } = await admin.from('sessions').select('id').in('id', sessionIds);
  if (leftover && leftover.length > 0) {
    console.warn(`[cleanup] ${leftover.length} session(s) survived purge:`, leftover.map((r: any) => r.id));
  }
}

/**
 * Delete waitlist entries for the given member ids plus any tracked
 * `waitlistIds`. Cascades through waitlist_members and clears any
 * audit_log rows that reference the waitlist entries by entity_id.
 */
export async function purgeWaitlistForMembers(
  admin: SupabaseAdmin,
  memberIds: string[],
  extraWaitlistIds: string[] = [],
): Promise<void> {
  let dynamicIds: string[] = [];
  if (memberIds.length > 0) {
    const { data, error } = await admin
      .from('waitlist_members')
      .select('waitlist_id')
      .in('member_id', memberIds);
    logStep('select waitlist by member', error);
    dynamicIds = (data ?? []).map((r: any) => r.waitlist_id);
  }

  const waitlistIds = Array.from(new Set([...dynamicIds, ...extraWaitlistIds]));
  if (waitlistIds.length === 0) return;

  const { error: auditErr } = await admin.from('audit_log').delete().in('entity_id', waitlistIds);
  logStep('delete audit_log (waitlist)', auditErr);

  const { error: wmErr } = await admin.from('waitlist_members').delete().in('waitlist_id', waitlistIds);
  logStep('delete waitlist_members', wmErr);

  const { error: wlErr } = await admin.from('waitlist').delete().in('id', waitlistIds);
  logStep('delete waitlist', wlErr);

  const { data: leftover } = await admin.from('waitlist').select('id').in('id', waitlistIds);
  if (leftover && leftover.length > 0) {
    console.warn(`[cleanup] ${leftover.length} waitlist entr(y/ies) survived purge:`, leftover.map((r: any) => r.id));
  }
}

/**
 * Delete blocks by id, clearing any audit_log rows that reference them.
 */
export async function purgeBlocksByIds(
  admin: SupabaseAdmin,
  blockIds: string[],
): Promise<void> {
  if (blockIds.length === 0) return;

  const { error: auditErr } = await admin.from('audit_log').delete().in('entity_id', blockIds);
  logStep('delete audit_log (blocks)', auditErr);

  const { error: blockErr } = await admin.from('blocks').delete().in('id', blockIds);
  logStep('delete blocks', blockErr);

  const { data: leftover } = await admin.from('blocks').select('id').in('id', blockIds);
  if (leftover && leftover.length > 0) {
    console.warn(`[cleanup] ${leftover.length} block(s) survived purge:`, leftover.map((r: any) => r.id));
  }
}

/**
 * Purge any active test sessions on the given courts.
 *
 * Only touches sessions that are demonstrably ours: id or
 * registered_by_member_id starts with `d0000000-`. This guard is airtight —
 * production data uses random UUIDs and cannot match the prefix — so this
 * call is safe to make on a shared live database.
 *
 * Call this in afterEach (after the normal purge) for every test file that
 * inserts active sessions on shared courts. The belt-and-suspenders double
 * purge prevents uq_one_active_session_per_court collisions when the primary
 * afterEach cleanup silently fails.
 */
export async function purgeActiveTestSessionsOnCourts(
  admin: SupabaseAdmin,
  courtIds: string[],
): Promise<void> {
  if (courtIds.length === 0) return;

  const TEST_PREFIX = 'd0000000-';

  const { data: byOwnId } = await admin
    .from('sessions')
    .select('id')
    .in('court_id', courtIds)
    .is('actual_end_at', null)
    .like('id', `${TEST_PREFIX}%`);

  const { data: byMemberId } = await admin
    .from('sessions')
    .select('id')
    .in('court_id', courtIds)
    .is('actual_end_at', null)
    .like('registered_by_member_id', `${TEST_PREFIX}%`);

  const sessionIds = Array.from(new Set([
    ...((byOwnId ?? []).map((r: any) => r.id) as string[]),
    ...((byMemberId ?? []).map((r: any) => r.id) as string[]),
  ]));

  if (sessionIds.length === 0) return;

  console.warn(`[cleanup] purgeActiveTestSessionsOnCourts: found ${sessionIds.length} active test session(s) to purge`);
  await purgeSessionsForMembers(admin, [], sessionIds);
}

/**
 * Convenience wrapper: run `fn` and log any thrown error instead of
 * propagating it. Use in afterEach so a cleanup failure never cascades into
 * "afterEach hook timed out" or masking the real test failure.
 */
export async function safeCleanup(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[cleanup] ${label} threw:`, e);
  }
}
