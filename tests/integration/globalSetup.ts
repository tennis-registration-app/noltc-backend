/**
 * Global setup for integration tests.
 *
 * Runs once before the entire suite. Deletes all deterministic test data
 * (records with d0000000-* prefix IDs) left over from a previous failed run.
 * This prevents stale sessions, waitlist entries, or members from causing
 * duplicate-key errors or unexpected state in the next run.
 *
 * Deletion order respects FK constraints:
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

  // Helper: delete rows matching the d0000000-* prefix and return deleted count
  async function clean(table: string, column: string): Promise<number> {
    const { data, error } = await supabase
      .from(table)
      .delete()
      .like(column, `${TEST_ID_PREFIX}%`)
      .select(column);
    if (error) {
      console.warn(`Global setup: failed to clean ${table}.${column} — ${error.message}`);
      return 0;
    }
    return data?.length ?? 0;
  }

  // FK-safe deletion order
  const txnCount      = await clean('transactions',        'session_id');
  const eventsCount   = await clean('session_events',      'session_id');
  const partCount     = await clean('session_participants', 'session_id');
  const sessCount     = await clean('sessions',            'id');

  const wmCount       = await clean('waitlist_members',    'waitlist_id');
  const wlCount       = await clean('waitlist',            'id');

  const blockCount    = await clean('blocks',              'id');

  const memberCount   = await clean('members',             'id');
  const acctCount     = await clean('accounts',            'id');

  const summary = [
    sessCount   && `${sessCount} session(s)`,
    wlCount     && `${wlCount} waitlist entr${wlCount === 1 ? 'y' : 'ies'}`,
    blockCount  && `${blockCount} block(s)`,
    memberCount && `${memberCount} member(s)`,
    acctCount   && `${acctCount} account(s)`,
    txnCount    && `${txnCount} transaction(s)`,
    eventsCount && `${eventsCount} session event(s)`,
    partCount   && `${partCount} participant(s)`,
  ].filter(Boolean);

  if (summary.length > 0) {
    console.log(`Global setup: cleaned ${summary.join(', ')}`);
  } else {
    console.log('Global setup: no stale test data found');
  }
}
