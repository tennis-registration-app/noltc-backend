#!/usr/bin/env node
/**
 * Minimal envelope contract tests for Edge Functions
 *
 * Verifies:
 * - ok exists and is boolean
 * - serverNow exists and is ISO string
 * - errors include code and message
 *
 * Run: SUPABASE_ANON_KEY=... node scripts/test-envelope-contracts.js
 * Or with custom URL: SUPABASE_ANON_KEY=... SUPABASE_URL=... node scripts/test-envelope-contracts.js
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dncjloqewjubodkoruou.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';

if (!SUPABASE_ANON_KEY) {
  console.error('Error: SUPABASE_ANON_KEY environment variable is required');
  console.error('Usage: SUPABASE_ANON_KEY=your-key node scripts/test-envelope-contracts.js');
  process.exit(1);
}

async function testEnvelope(endpoint, method, body = null, expectError = false) {
  const errors = [];

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

    const data = await response.json();

    // Check ok field
    if (typeof data.ok !== 'boolean') {
      errors.push(`'ok' should be boolean, got ${typeof data.ok}`);
    }

    // Check serverNow field
    if (typeof data.serverNow !== 'string') {
      errors.push(`'serverNow' should be string, got ${typeof data.serverNow}`);
    } else if (!/^\d{4}-\d{2}-\d{2}T/.test(data.serverNow)) {
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

async function runTests() {
  console.log('\n=== Envelope Contract Tests ===\n');
  console.log(`Testing against: ${SUPABASE_URL}\n`);

  const results = [];

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

  if (passed < total) {
    process.exit(1);
  }
}

runTests();
