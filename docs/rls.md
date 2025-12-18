# Row Level Security Policies

## Strategy

- **RLS enabled on ALL 16 tables**
- **Clients (anon key)**: Read-only access to all tables
- **Clients CANNOT write** to any tables directly
- **Edge Functions (service_role key)**: Bypass RLS, can perform all operations

This ensures all mutations go through controlled Edge Functions.

## Tables with RLS Enabled

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| accounts | ✅ anon | ❌ | ❌ | ❌ |
| members | ✅ anon | ❌ | ❌ | ❌ |
| courts | ✅ anon | ❌ | ❌ | ❌ |
| devices | ✅ anon | ❌ | ❌ | ❌ |
| sessions | ✅ anon | ❌ | ❌ | ❌ |
| session_participants | ✅ anon | ❌ | ❌ | ❌ |
| waitlist | ✅ anon | ❌ | ❌ | ❌ |
| waitlist_members | ✅ anon | ❌ | ❌ | ❌ |
| blocks | ✅ anon | ❌ | ❌ | ❌ |
| transactions | ✅ anon | ❌ | ❌ | ❌ |
| exports | ✅ anon | ❌ | ❌ | ❌ |
| export_items | ✅ anon | ❌ | ❌ | ❌ |
| audit_log | ✅ anon | ❌ | ❌ | ❌ |
| system_settings | ✅ anon | ❌ | ❌ | ❌ |
| operating_hours | ✅ anon | ❌ | ❌ | ❌ |
| operating_hours_overrides | ✅ anon | ❌ | ❌ | ❌ |

## Write Access

All writes MUST go through Edge Functions which use the `service_role` key.
The service_role key bypasses RLS entirely, allowing Edge Functions to:
- Insert new sessions, waitlist entries, transactions
- Update session end times, waitlist status
- Log to audit_log

## Security Notes

- No sensitive data is exposed (pin_hash is NULL for MVP)
- Member numbers are visible for registration lookup
- All mutation requests are validated and logged by Edge Functions
