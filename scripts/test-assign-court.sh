#!/bin/bash

# =============================================================================
# USAGE
#
# Option 1 — env vars inline:
#   SUPABASE_URL=https://your-ref.supabase.co \
#   SUPABASE_ANON_KEY=eyJ... \
#   bash scripts/test-assign-court.sh
#
# Option 2 — create .env from .env.example:
#   cp .env.example .env
#   # Fill in your values, then:
#   bash scripts/test-assign-court.sh
#
# =============================================================================
# WARNING: This script hits PRODUCTION.
#
# Running this script will create real sessions and modify production data.
# Only run this intentionally for post-deploy validation.
# =============================================================================

# NOLTC Backend - Test assign-court Edge Function

# Load .env.local or .env if present (env vars already in the environment take precedence)
for dotenv_file in ".env.local" ".env"; do
  if [ -f "$dotenv_file" ]; then
    export $(grep -v '^#' "$dotenv_file" | grep -v '^$' | xargs) 2>/dev/null || true
    break
  fi
done

# Validate required env vars
if [ -z "$SUPABASE_URL" ]; then
  echo "Error: SUPABASE_URL is not set."
  echo "  Get this from: Supabase Dashboard → Project Settings → API"
  echo "  This is the project URL (e.g. https://your-project-ref.supabase.co)"
  echo ""
  echo "  Run with env vars inline:"
  echo "    SUPABASE_URL=https://... SUPABASE_ANON_KEY=eyJ... bash scripts/test-assign-court.sh"
  echo ""
  echo "  Or create a .env file from the example to avoid passing vars every time:"
  echo "    cp .env.example .env  # fill in your values"
  exit 1
fi

if [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "Error: SUPABASE_ANON_KEY is not set."
  echo "  Get this from: Supabase Dashboard → Project Settings → API Keys (the JWT-format key starting with eyJ...)"
  echo ""
  echo "  Run with env vars inline:"
  echo "    SUPABASE_URL=https://... SUPABASE_ANON_KEY=eyJ... bash scripts/test-assign-court.sh"
  echo ""
  echo "  Or create a .env file from the example to avoid passing vars every time:"
  echo "    cp .env.example .env  # fill in your values"
  exit 1
fi

ANON_KEY="$SUPABASE_ANON_KEY"

# --- Runtime safety guard ---
echo ""
echo "WARNING: This script targets PRODUCTION."
echo "  URL: ${SUPABASE_URL}"
echo "  It will create real sessions and modify production data."
echo ""
read -p "Continue? [y/N] " confirm
if [[ ! "$confirm" =~ ^[yY]$ ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

# Test 1: Singles match - John Smith and Bob Johnson
echo "=== Test 1: Singles Match ==="
curl -X POST "${SUPABASE_URL}/functions/v1/assign-court" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "court_id": "a35cf3b7-8db2-4fb5-b3ef-fc745bbe5d3f",
    "session_type": "singles",
    "participants": [
      {
        "type": "member",
        "member_id": "c0000000-0000-0000-0000-000000000001",
        "account_id": "b0000000-0000-0000-0000-000000000001"
      },
      {
        "type": "member",
        "member_id": "c0000000-0000-0000-0000-000000000003",
        "account_id": "b0000000-0000-0000-0000-000000000002"
      }
    ],
    "device_id": "a0000000-0000-0000-0000-000000000001",
    "device_type": "kiosk"
  }'

echo ""
echo ""

# Test 2: Should fail - court already occupied
echo "=== Test 2: Should Fail - Court Occupied ==="
curl -X POST "${SUPABASE_URL}/functions/v1/assign-court" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "court_id": "a35cf3b7-8db2-4fb5-b3ef-fc745bbe5d3f",
    "session_type": "singles",
    "participants": [
      {
        "type": "member",
        "member_id": "c0000000-0000-0000-0000-000000000002",
        "account_id": "b0000000-0000-0000-0000-000000000001"
      }
    ],
    "device_id": "a0000000-0000-0000-0000-000000000001",
    "device_type": "kiosk"
  }'

echo ""
