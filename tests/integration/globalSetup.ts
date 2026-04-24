/**
 * Global setup / teardown for integration tests.
 *
 * setup()    — runs once before the entire suite
 * teardown() — runs once after the entire suite
 *
 * Responsibilities:
 *  1. Delete all test data left from a prior failed run so tests start clean.
 *  2. Override operating hours to 24/7 so time-dependent tests (assign-court,
 *     join-waitlist) pass regardless of when the suite runs.
 *  3. Restore original operating hours after the suite finishes.
 *
 * Cleanup uses two passes:
 *
 *   1. ID-range pass — rows whose own id falls in the d0000000-* UUID range
 *      (direct inserts from test fixtures).
 *
 *   2. FK pass — rows that reference a test fixture by foreign key but
 *      whose own id is random (created by edge functions during a test
 *      that crashed before afterEach could clean up).
 *
 *      Without this pass, flakes pile up: move-court sees leftover sessions
 *      on its courts and returns 409, assign-from-waitlist sees a test
 *      member already on an active session and denies the assignment, etc.
 *
 * UUID columns don't support LIKE — use gte/lt range filters instead.
 * All test UUIDs start with 'd0000000-', which falls between
 * d0000000-0000-... and d0000001-0000-... lexicographically.
 *
 * FK-safe deletion order within each pass:
 *   transactions → session_events → session_participants → sessions
 *   waitlist_members → waitlist
 *   blocks
 *   members → accounts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Bounds for all d0000000-* test UUIDs ─────────────────────────────────────
const TEST_UUID_GTE = 'd0000000-0000-0000-0000-000000000000';
const TEST_UUID_LT  = 'd0000001-0000-0000-0000-000000000000';

// ── Module-level state shared between setup() and teardown() ──────────────────

type OperatingHoursRow = {
  id: string;
  day_of_week: number;
  opens_at: string;
  closes_at: string;
  is_closed: boolean;
};

type OverrideRow = {
  id: string;
  date: string;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
  reason: string | null;
  created_by_device_id: string;
};

let adminClient: SupabaseClient | null = null;
let savedHours: OperatingHoursRow[] = [];
let deletedOverrides: OverrideRow[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Today's date in America/Chicago, formatted as YYYY-MM-DD. */
function todayChicago(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// ── setup() ───────────────────────────────────────────────────────────────────

export async function setup() {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!url || !key) {
    console.log('Global setup: env vars missing — skipping pre-run cleanup and hours override');
    return;
  }

  adminClient = createClient(url, key);
  const supabase = adminClient;

  // ── 1. Stale data cleanup ──────────────────────────────────────────────────

  // ---------------- Sessions ----------------
  // Union of sessions by own-id range AND sessions registered by a test member.
  const { data: sessByPrefix } = await supabase
    .from('sessions')
    .select('id')
    .gte('id', TEST_UUID_GTE)
    .lt('id', TEST_UUID_LT);

  const { data: sessByMember } = await supabase
    .from('sessions')
    .select('id')
    .gte('registered_by_member_id', TEST_UUID_GTE)
    .lt('registered_by_member_id', TEST_UUID_LT);

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
  // Union of waitlist by own-id range AND waitlist entries with any test member.
  const { data: wlByPrefix } = await supabase
    .from('waitlist')
    .select('id')
    .gte('id', TEST_UUID_GTE)
    .lt('id', TEST_UUID_LT);

  const { data: wlByMember } = await supabase
    .from('waitlist_members')
    .select('waitlist_id')
    .gte('member_id', TEST_UUID_GTE)
    .lt('member_id', TEST_UUID_LT);

  const waitlistIds = Array.from(new Set([
    ...(wlByPrefix ?? []).map((r: any) => r.id),
    ...(wlByMember ?? []).map((r: any) => r.waitlist_id),
  ]));

  if (waitlistIds.length > 0) {
    await supabase.from('waitlist_members').delete().in('waitlist_id', waitlistIds);
    await supabase.from('waitlist').delete().in('id', waitlistIds);
  }

  // ---------------- Blocks ----------------
  // Union of blocks by own-id range AND blocks created by a test admin device
  // (create-block tests use d0000000-* admin devices).
  const { data: blocksByPrefix } = await supabase
    .from('blocks')
    .select('id')
    .gte('id', TEST_UUID_GTE)
    .lt('id', TEST_UUID_LT);

  const { data: blocksByDevice } = await supabase
    .from('blocks')
    .select('id')
    .gte('created_by_device_id', TEST_UUID_GTE)
    .lt('created_by_device_id', TEST_UUID_LT);

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
  // These only use the d0000000-* range — no FK pass needed.
  const { data: memberRows } = await supabase
    .from('members')
    .delete()
    .gte('id', TEST_UUID_GTE)
    .lt('id', TEST_UUID_LT)
    .select('id');

  const { data: acctRows } = await supabase
    .from('accounts')
    .delete()
    .gte('id', TEST_UUID_GTE)
    .lt('id', TEST_UUID_LT)
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

  // ── 2. Save and override operating hours to 24/7 ──────────────────────────

  const { data: hours, error: hoursError } = await supabase
    .from('operating_hours')
    .select('id, day_of_week, opens_at, closes_at, is_closed')
    .order('day_of_week');

  if (hoursError || !hours) {
    console.warn(`Global setup: could not fetch operating_hours — ${hoursError?.message}. Skipping hours override.`);
  } else {
    savedHours = hours as OperatingHoursRow[];

    // Update all 7 days to 24/7
    const { error: updateError } = await supabase
      .from('operating_hours')
      .update({ opens_at: '00:00:00', closes_at: '23:59:59', is_closed: false })
      .gte('day_of_week', 0);  // matches all rows (day_of_week 0–6)

    if (updateError) {
      console.warn(`Global setup: failed to set 24/7 hours — ${updateError.message}`);
    } else {
      console.log('Global setup: operating hours set to 24/7');
    }
  }

  // ── 3. Delete any closed overrides for today ──────────────────────────────

  const today = todayChicago();
  const { data: overrides, error: ovError } = await supabase
    .from('operating_hours_overrides')
    .select('id, date, opens_at, closes_at, is_closed, reason, created_by_device_id')
    .eq('date', today)
    .eq('is_closed', true);

  if (ovError) {
    console.warn(`Global setup: could not check operating_hours_overrides — ${ovError.message}`);
  } else if (overrides && overrides.length > 0) {
    deletedOverrides = overrides as OverrideRow[];
    const ids = deletedOverrides.map(r => r.id);
    const { error: delError } = await supabase
      .from('operating_hours_overrides')
      .delete()
      .in('id', ids);
    if (delError) {
      console.warn(`Global setup: failed to delete closed overrides for today — ${delError.message}`);
      deletedOverrides = [];
    } else {
      console.log(`Global setup: removed ${ids.length} closed override(s) for ${today}`);
    }
  }
}

// ── teardown() ────────────────────────────────────────────────────────────────

export async function teardown() {
  if (!adminClient) {
    return;  // env vars were missing in setup — nothing to restore
  }

  // ── 1. Restore original operating hours ───────────────────────────────────

  if (savedHours.length > 0) {
    const errors: string[] = [];
    for (const row of savedHours) {
      const { error } = await adminClient
        .from('operating_hours')
        .update({ opens_at: row.opens_at, closes_at: row.closes_at, is_closed: row.is_closed })
        .eq('id', row.id);
      if (error) errors.push(`day ${row.day_of_week}: ${error.message}`);
    }
    if (errors.length > 0) {
      console.warn(`Global teardown: failed to restore some hours — ${errors.join('; ')}`);
    } else {
      console.log('Global teardown: operating hours restored');
    }
  }

  // ── 2. Re-insert deleted overrides ────────────────────────────────────────

  if (deletedOverrides.length > 0) {
    const { error } = await adminClient
      .from('operating_hours_overrides')
      .insert(deletedOverrides);
    if (error) {
      console.warn(`Global teardown: failed to restore overrides — ${error.message}`);
    } else {
      console.log(`Global teardown: restored ${deletedOverrides.length} override(s)`);
    }
  }
}
