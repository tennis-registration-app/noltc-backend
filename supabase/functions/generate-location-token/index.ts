import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Generate a random 32-character token
function generateToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars (0/O, 1/I/L)
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json()
    const { device_id, validity_minutes = 5 } = body
    const serverNow = new Date().toISOString()

    // Validate device_id
    if (!device_id) {
      return new Response(
        JSON.stringify({ ok: false, code: 'MISSING_DEVICE', message: 'device_id is required', serverNow }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Verify device exists and is kiosk or admin (not mobile)
    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('id, device_type, is_active')
      .eq('id', device_id)
      .single()

    if (deviceError || !device) {
      return new Response(
        JSON.stringify({ ok: false, code: 'INVALID_DEVICE', message: 'Device not found', serverNow }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    if (!device.is_active) {
      return new Response(
        JSON.stringify({ ok: false, code: 'DEVICE_INACTIVE', message: 'Device is not active', serverNow }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    // Only kiosk and admin can generate tokens (not mobile)
    if (device.device_type === 'mobile') {
      return new Response(
        JSON.stringify({ ok: false, code: 'UNAUTHORIZED', message: 'Mobile devices cannot generate location tokens', serverNow }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 }
      )
    }

    // Generate token
    const token = generateToken()
    const expiresAt = new Date(Date.now() + validity_minutes * 60 * 1000).toISOString()

    // Insert token
    const { data: tokenRow, error: insertError } = await supabase
      .from('location_tokens')
      .insert({
        token,
        expires_at: expiresAt,
        created_by_device_id: device_id,
      })
      .select('id, token, expires_at')
      .single()

    if (insertError) {
      console.error('Failed to insert token:', insertError)
      return new Response(
        JSON.stringify({ ok: false, code: 'INSERT_FAILED', message: 'Failed to generate token', serverNow }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    // Audit log
    await supabase
      .from('audit_log')
      .insert({
        action: 'generate_location_token',
        device_id: device_id,
        details: {
          token_id: tokenRow.id,
          expires_at: expiresAt,
          validity_minutes,
        },
        created_at: serverNow,
      })

    return new Response(
      JSON.stringify({
        ok: true,
        token: tokenRow.token,
        expiresAt: tokenRow.expires_at,
        serverNow,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', message: error.message, serverNow: new Date().toISOString() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
