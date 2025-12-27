import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    const { device_id, waitlist_entry_id, reason } = body
    const serverNow = new Date().toISOString()

    // Validate required fields
    if (!device_id) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'MISSING_DEVICE',
          message: 'device_id is required',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    if (!waitlist_entry_id) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'MISSING_WAITLIST_ENTRY',
          message: 'waitlist_entry_id is required',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Verify admin device
    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('id, device_type, is_active')
      .eq('id', device_id)
      .single()

    if (deviceError || !device) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'INVALID_DEVICE',
          message: 'Device not found',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    if (!device.is_active) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'DEVICE_INACTIVE',
          message: 'Device is not active',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    // Check admin authorization
    if (device.device_type !== 'admin') {
      await supabase
        .from('audit_log')
        .insert({
          action: 'remove_from_waitlist_unauthorized',
          entity_type: 'waitlist',
          entity_id: waitlist_entry_id,
          device_id: device.id,
          device_type: device.device_type,
          request_data: { waitlist_entry_id, reason },
          outcome: 'denied',
          error_message: 'Admin access required',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })

      return new Response(
        JSON.stringify({
          ok: false,
          code: 'UNAUTHORIZED',
          message: 'Admin access required',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 }
      )
    }

    // Get waitlist entry details before removal
    console.log('[remove-from-waitlist] Looking up waitlist entry:', waitlist_entry_id)
    const { data: entry, error: entryError } = await supabase
      .from('waitlist')
      .select(`
        id,
        status,
        group_type,
        created_at,
        waitlist_members (
          member_id,
          guest_name
        )
      `)
      .eq('id', waitlist_entry_id)
      .single()

    console.log('[remove-from-waitlist] Query result:', { entry, entryError })

    if (entryError || !entry) {
      console.error('[remove-from-waitlist] Entry not found. Error:', entryError)
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'WAITLIST_ENTRY_NOT_FOUND',
          message: 'Waitlist entry not found',
          debug: { waitlist_entry_id, entryError: entryError?.message },
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
      )
    }

    if (entry.status !== 'waiting') {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'ENTRY_NOT_ACTIVE',
          message: `Waitlist entry is not active (status: ${entry.status})`,
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 409 }
      )
    }

    // Update waitlist entry status to cancelled (admin removed)
    const { error: updateError } = await supabase
      .from('waitlist')
      .update({
        status: 'cancelled',
      })
      .eq('id', waitlist_entry_id)

    if (updateError) {
      throw updateError
    }

    // Insert board change signal
    await supabase
      .from('board_change_signals')
      .insert({ change_type: 'waitlist' })

    // Audit log
    await supabase
      .from('audit_log')
      .insert({
        action: 'remove_from_waitlist',
        entity_type: 'waitlist',
        entity_id: waitlist_entry_id,
        device_id: device.id,
        device_type: device.device_type,
        request_data: {
          waitlist_entry_id,
          reason: reason || 'admin_removed',
          group_type: entry.group_type,
          participants: entry.waitlist_members,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    return new Response(
      JSON.stringify({
        ok: true,
        message: 'Removed from waitlist',
        waitlistEntryId: waitlist_entry_id,
        serverNow,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: error.message,
        serverNow: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
