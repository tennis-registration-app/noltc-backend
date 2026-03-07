/**
 * Minimal envelope contract tests for Edge Functions
 *
 * WARNING: Defaults to the PRODUCTION Supabase URL if SUPABASE_URL is not set.
 * Only run this intentionally for post-deploy validation.
 *
 * Verifies:
 * - ok exists and is boolean
 * - serverNow exists and is ISO string
 * - errors include code and message
 *
 * Required env vars:
 *   SUPABASE_ANON_KEY  — the anon key for the target Supabase project
 *
 * Optional env vars:
 *   SUPABASE_URL       — override the target URL (defaults to production)
 *
 * Run: SUPABASE_ANON_KEY=... npx ts-node scripts/test-envelope-contracts.ts
 * Or with custom URL: SUPABASE_ANON_KEY=... SUPABASE_URL=... npx ts-node scripts/test-envelope-contracts.ts
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dncjloqewjubodkoruou.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';

if (!SUPABASE_ANON_KEY) {
  console.error('Error: SUPABASE_ANON_KEY environment variable is required');
  console.error('Usage: SUPABASE_ANON_KEY=your-key npx ts-node scripts/test-envelope-contracts.ts');
  process.exit(1);
}

interface TestResult {
  endpoint: string;
  passed: boolean;
  errors: string[];
}

async function testEnvelope(
  endpoint: string,
  method: string,
  body?: object,
  expectError: boolean = false
): Promise<TestResult> {
  const errors: string[] = [];

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'x-device-id': DEVICE_ID,
        'x-device-type': 'kiosk',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as Record<string, unknown>;

    // Check ok field
    if (typeof data.ok !== 'boolean') {
      errors.push(`'ok' should be boolean, got ${typeof data.ok}`);
    }

    // Check serverNow field
    if (typeof data.serverNow !== 'string') {
      errors.push(`'serverNow' should be string, got ${typeof data.serverNow}`);
    } else if (!/^\d{4}-\d{2}-\d{2}T/.test(data.serverNow as string)) {
      errors.push(`'serverNow' should be ISO format, got ${data.serverNow}`);
    }

    // If error response, check code and message
    if (data.ok === false || expectError) {
      if (typeof data.code !== 'string') {
        errors.push(`Error response missing 'code' string`);
      }
      if (typeof data.message !== 'string') {
        errors.push(`Error response missing 'message' string`);
      }
    }

    console.log(`${errors.length === 0 ? '✅' : '❌'} ${endpoint} (${method})`);
    if (errors.length > 0) {
      errors.forEach((e) => console.log(`   - ${e}`));
    }
  } catch (e) {
    errors.push(`Request failed: ${e}`);
    console.log(`❌ ${endpoint} (${method})`);
    console.log(`   - ${e}`);
  }

  return { endpoint, passed: errors.length === 0, errors };
}

interface DiscoveryResult extends TestResult {
  actualKeys: string[];
}

/**
 * Discovery probe — same envelope checks as testEnvelope, but on failure
 * prints the actual top-level keys so deviations are visible rather than silent.
 */
async function discoveryProbe(
  endpoint: string,
  method: string,
  body?: object
): Promise<DiscoveryResult> {
  const errors: string[] = [];
  let actualKeys: string[] = [];

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'x-device-id': DEVICE_ID,
        'x-device-type': 'kiosk',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as Record<string, unknown>;
    actualKeys = Object.keys(data).sort();

    if (typeof data.ok !== 'boolean') {
      errors.push(`'ok' should be boolean, got ${typeof data.ok}`);
    }
    if (typeof data.serverNow !== 'string') {
      errors.push(`'serverNow' should be string, got ${typeof data.serverNow}`);
    } else if (!/^\d{4}-\d{2}-\d{2}T/.test(data.serverNow as string)) {
      errors.push(`'serverNow' should be ISO format, got ${data.serverNow}`);
    }
    if (data.ok === false) {
      if (typeof data.code !== 'string') {
        errors.push(`Error response missing 'code' string`);
      }
      if (typeof data.message !== 'string') {
        errors.push(`Error response missing 'message' string`);
      }
    }

    const label = errors.length === 0 ? '✅' : '🔍';
    console.log(`${label} ${endpoint} (${method}) [discovery]`);
    if (errors.length > 0) {
      errors.forEach((e) => console.log(`   - ${e}`));
      console.log(`   actual keys: [${actualKeys.join(', ')}]`);
    }
  } catch (e) {
    errors.push(`Request failed: ${e}`);
    console.log(`❌ ${endpoint} (${method}) [discovery]`);
    console.log(`   - ${e}`);
  }

  return { endpoint, passed: errors.length === 0, errors, actualKeys };
}

async function runTests() {
  console.log('\n=== Envelope Contract Tests ===\n');
  console.log(`Testing against: ${SUPABASE_URL}\n`);

  const results: TestResult[] = [];

  // Test get-board (success case)
  results.push(await testEnvelope('get-board', 'GET'));

  // Test end-session with invalid data (error case)
  results.push(
    await testEnvelope(
      'end-session',
      'POST',
      {
        session_id: 'invalid',
        end_reason: 'invalid_reason',
        device_id: DEVICE_ID,
        device_type: 'kiosk',
      },
      true
    )
  );

  // Test end-session with missing data (error case)
  results.push(
    await testEnvelope(
      'end-session',
      'POST',
      {
        device_id: DEVICE_ID,
        device_type: 'kiosk',
      },
      true
    )
  );

  // Test assign-court with invalid data (error case)
  results.push(
    await testEnvelope(
      'assign-court',
      'POST',
      {
        court_id: 'invalid',
        device_id: DEVICE_ID,
        device_type: 'kiosk',
      },
      true
    )
  );

  // Test remove-from-waitlist with invalid data (error case)
  results.push(
    await testEnvelope(
      'remove-from-waitlist',
      'POST',
      {
        waitlist_entry_id: 'not-a-uuid',
        device_id: DEVICE_ID,
        device_type: 'kiosk',
      },
      true
    )
  );

  // Summary
  console.log('\n=== Summary ===\n');
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`${passed}/${total} tests passed`);

  // --- Discovery probes (not counted in pass/fail) ---
  console.log('\n=== Discovery Probes ===\n');
  console.log('These check envelope shape of endpoints not yet in the main test suite.\n');

  const discovery: DiscoveryResult[] = [];

  // join-waitlist with invalid group_type — hits early validation, no mutation
  discovery.push(
    await discoveryProbe('join-waitlist', 'POST', {
      group_type: 'invalid',
      participants: [],
      device_id: DEVICE_ID,
      device_type: 'kiosk',
    })
  );

  // assign-from-waitlist with missing required fields — hits early validation, no mutation
  discovery.push(
    await discoveryProbe('assign-from-waitlist', 'POST', {
      device_id: DEVICE_ID,
      device_type: 'kiosk',
    })
  );

  const discoveryMatched = discovery.filter((d) => d.passed).length;
  console.log(`\n${discoveryMatched}/${discovery.length} discovery probes match shared envelope`);
  if (discoveryMatched < discovery.length) {
    console.log('Review deviations above — these are informational, not failures.');
  }

  if (passed < total) {
    process.exit(1);
  }
}

runTests();
