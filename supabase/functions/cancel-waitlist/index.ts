import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CancelWaitlistRequest {
  waitlist_id: string
  device_id: string
  device_type: string
  initiated_by?: 'user' | 'ai_assistant'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  let requestData: CancelWaitlistRequest | null = null

  try {
    requestData = await req.json() as CancelWaitlistRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.waitlist_id) {
      throw new Error('waitlist_id is required')
    }
    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // ===========================================
    // VERIFY DEVICE EXISTS
    // ===========================================

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      throw new Error('Device not registered')
    }

    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    // ===========================================
    // FIND THE WAITLIST ENTRY
    // ===========================================

    const { data: waitlistEntry, error: waitlistError } = await supabase
      .from('waitlist')
      .select('*')
      .eq('id', requestData.waitlist_id)
      .single()

    if (waitlistError || !waitlistEntry) {
      throw new Error('Waitlist entry not found')
    }

    if (waitlistEntry.status !== 'waiting') {
      throw new Error(`Cannot cancel - status is "${waitlistEntry.status}"`)
    }

    const cancelledPosition = waitlistEntry.position

    // ===========================================
    // GET PARTICIPANT NAMES FOR RESPONSE
    // ===========================================

    const { data: participants } = await supabase
      .from('waitlist_members')
      .select(`
        participant_type,
        guest_name,
        members(display_name)
      `)
      .eq('waitlist_id', requestData.waitlist_id)

    const participantNames = participants?.map(p =>
      p.participant_type === 'member' ? p.members?.display_name : p.guest_name
    ) || []

    // ===========================================
    // CANCEL THE ENTRY
    // ===========================================

    const { error: updateError } = await supabase
      .from('waitlist')
      .update({ status: 'cancelled' })
      .eq('id', requestData.waitlist_id)

    if (updateError) {
      throw new Error(`Failed to cancel: ${updateError.message}`)
    }

    // ===========================================
    // REORDER REMAINING ENTRIES
    // ===========================================

    // Get all waiting entries with position > cancelled position
    const { data: entriesToUpdate } = await supabase
      .from('waitlist')
      .select('id, position')
      .eq('status', 'waiting')
      .gt('position', cancelledPosition)
      .order('position', { ascending: true })

    // Decrement each position
    if (entriesToUpdate && entriesToUpdate.length > 0) {
      for (const entry of entriesToUpdate) {
        await supabase
          .from('waitlist')
          .update({ position: entry.position - 1 })
          .eq('id', entry.id)
      }
    }

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'waitlist_cancel',
        entity_type: 'waitlist',
        entity_id: waitlistEntry.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        request_data: {
          group_type: waitlistEntry.group_type,
          position: cancelledPosition,
          participant_count: participantNames.length,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      waitlist: {
        id: waitlistEntry.id,
        group_type: waitlistEntry.group_type,
        previous_position: cancelledPosition,
        status: 'cancelled',
        participants: participantNames,
      },
      positions_updated: entriesToUpdate?.length || 0,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Audit log - failure
    await supabase
      .from('audit_log')
      .insert({
        action: 'waitlist_cancel',
        entity_type: 'waitlist',
        entity_id: requestData?.waitlist_id || '00000000-0000-0000-0000-000000000000',
        device_id: requestData?.device_id || null,
        device_type: requestData?.device_type || null,
        initiated_by: requestData?.initiated_by || 'user',
        request_data: requestData,
        outcome: 'failure',
        error_message: error.message,
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    return new Response(JSON.stringify({
      ok: false,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
