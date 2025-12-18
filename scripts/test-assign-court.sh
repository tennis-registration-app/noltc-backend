#!/bin/bash

# NOLTC Backend - Test assign-court Edge Function
# Replace ANON_KEY with your actual anon key

SUPABASE_URL="https://dncjloqewjubodkoruou.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuY2psb3Fld2p1Ym9ka29ydW91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwNDc4MTEsImV4cCI6MjA4MTYyMzgxMX0.JwK7d01-MH57UD80r7XD2X3kv5W5JFBZecmXsrAiTP4"

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
