import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log("🔥 REORDER-WAITLIST endpoint hit")

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const body = await req.json()
    const { device_id, entry_id, new_position } = body
    const serverNow = new Date().toISOString()

    // Validate required fields
    if (!device_id) {
      return new Response(
        JSON.stringify({ ok: false, error: 'device_id is required', serverNow }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!entry_id) {
      return new Response(
        JSON.stringify({ ok: false, error: 'entry_id is required', serverNow }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (typeof new_position !== 'number' || new_position < 1) {
      return new Response(
        JSON.stringify({ ok: false, error: 'new_position must be a positive integer', serverNow }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify admin device
    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('id, device_type')
      .eq('id', device_id)
      .single()

    if (deviceError || !device) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Invalid device', serverNow }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (device.device_type !== 'admin') {
      return new Response(
        JSON.stringify({ ok: false, error: 'Admin access required', serverNow }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Call the atomic RPC
    const { data, error } = await supabase.rpc('reorder_waitlist', {
      p_entry_id: entry_id,
      p_new_position: new_position,
      p_device_id: device_id,
    })

    console.log("🔥 RPC result:", JSON.stringify({ data, error }))

    if (error) {
      return new Response(
        JSON.stringify({ ok: false, error: error.message, serverNow }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!data.success) {
      return new Response(
        JSON.stringify({ ok: false, error: data.error, serverNow }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Signal board change for real-time updates
    await supabase.from('board_change_signals').insert({
      change_type: 'waitlist',
    })

    return new Response(
      JSON.stringify({
        ok: true,
        old_position: data.old_position,
        new_position: data.new_position,
        serverNow,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Error in reorder-waitlist:', err)
    return new Response(
      JSON.stringify({ ok: false, error: err.message, serverNow: new Date().toISOString() }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
