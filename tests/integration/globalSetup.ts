/**
 * Global setup for integration tests.
 *
 * Runs once before the entire suite. Deletes all test data left over from a
 * previous failed run so the next run starts from a clean slate.
 *
 * Cleanup uses two passes:
 *
 *   1. ID-prefix pass — rows whose own id starts with `d0000000-*` (direct
 *      inserts from test fixtures).
 *
 *   2. FK pass — rows that reference a test fixture by foreign key but
 *      whose own id is random (created by edge functions during a test
 *      that crashed before afterEach could clean up).
 *
 *      Without this pass, flakes pile up: move-court sees leftover sessions
 *      on its courts and returns 409, assign-from-waitlist sees a test
 *      member already on an active session and denies the assignment, etc.
 *
 * FK-safe deletion order within each pass:
 *   transactions → session_events → session_participants → sessions
 *   waitlist_members → waitlist
 *   blocks
 *   members → accounts
 */

import { createClient } from '@supabase/supabase-js';

const TEST_ID_PREFIX = 'd0000000-';

export async function setup() {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!url || !key) {
    console.log('Global setup: env vars missing — skipping pre-run cleanup');
    return;
  }

  const supabase = createClient(url, key);

  // ---------------- Sessions ----------------
  // Union of sessions by own-id prefix AND sessions registered by a test member.
  const { data: sessByPrefix } = await supabase
    .from('sessions')
    .select('id')
    .like('id', `${TEST_ID_PREFIX}%`);

  const { data: sessByMember } = await supabase
    .from('sessions')
    .select('id')
    .like('registered_by_member_id', `${TEST_ID_PREFIX}%`);

  const sessionIds = Array.from(new Set([
    ...(sessByPrefix ?? []).map((r: any) => r.id),
    ...(sessByMember ?? []).map((r: any) => r.id),
  ]));

  if (sessionIds.length > 0) {
    await supabase.from('transactions').delete().in('session_id', sessionIds);
    await supabase.from('session_events').delete().in('session_id', sessionIds);
    await supabase.from('session_participants').delete().in('session_id', sessionIds);
    await supabase.from('sessions').delete().in('id', sessionIds);
  }

  // ---------------- Waitlist ----------------
  // Union of waitlist by own-id prefix AND waitlist entries with any test member.
  const { data: wlByPrefix } = await supabase
    .from('waitlist')
    .select('id')
    .like('id', `${TEST_ID_PREFIX}%`);

  const { data: wlByMember } = await supabase
    .from('waitlist_members')
    .select('waitlist_id')
    .like('member_id', `${TEST_ID_PREFIX}%`);

  const waitlistIds = Array.from(new Set([
    ...(wlByPrefix ?? []).map((r: any) => r.id),
    ...(wlByMember ?? []).map((r: any) => r.waitlist_id),
  ]));

  if (waitlistIds.length > 0) {
    await supabase.from('waitlist_members').delete().in('waitlist_id', waitlistIds);
    await supabase.from('waitlist').delete().in('id', waitlistIds);
  }

  // ---------------- Blocks ----------------
  // Union of blocks by own-id prefix AND blocks created by a test admin device
  // (create-block tests use d0000000-* admin devices).
  const { data: blocksByPrefix } = await supabase
    .from('blocks')
    .select('id')
    .like('id', `${TEST_ID_PREFIX}%`);

  const { data: blocksByDevice } = await supabase
    .from('blocks')
    .select('id')
    .like('created_by_device_id', `${TEST_ID_PREFIX}%`);

  const blockIds = Array.from(new Set([
    ...(blocksByPrefix ?? []).map((r: any) => r.id),
    ...(blocksByDevice ?? []).map((r: any) => r.id),
  ]));

  if (blockIds.length > 0) {
    // audit_log entries reference blocks by entity_id
    await supabase.from('audit_log').delete().in('entity_id', blockIds);
    await supabase.from('blocks').delete().in('id', blockIds);
  }

  // ---------------- Members / Accounts ----------------
  // These only use the d0000000-* prefix — no FK pass needed.
  const { data: memberRows } = await supabase
    .from('members')
    .delete()
    .like('id', `${TEST_ID_PREFIX}%`)
    .select('id');

  const { data: acctRows } = await supabase
    .from('accounts')
    .delete()
    .like('id', `${TEST_ID_PREFIX}%`)
    .select('id');

  const summary = [
    sessionIds.length  && `${sessionIds.length} session(s)`,
    waitlistIds.length && `${waitlistIds.length} waitlist entr${waitlistIds.length === 1 ? 'y' : 'ies'}`,
    blockIds.length    && `${blockIds.length} block(s)`,
    memberRows?.length && `${memberRows.length} member(s)`,
    acctRows?.length   && `${acctRows.length} account(s)`,
  ].filter(Boolean);

  if (summary.length > 0) {
    console.log(`Global setup: cleaned ${summary.join(', ')}`);
  } else {
    console.log('Global setup: no stale test data found');
  }
}
