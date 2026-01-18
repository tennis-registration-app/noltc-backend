import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { signalBoardChange } from '../_shared/sessionLifecycle.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Participant {
  name: string
  type: 'member' | 'guest'
  member_id?: string
}

interface UpdateSessionRequest {
  session_id: string
  participants: Participant[]
  scheduled_end_at: string | null  // null means "no end time" -> set to midnight
  device_id: string
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

    const body: UpdateSessionRequest = await req.json()
    const { session_id, participants, scheduled_end_at, device_id } = body
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

    if (!session_id) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'MISSING_SESSION',
          message: 'session_id is required',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    if (!participants || !Array.isArray(participants)) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'MISSING_PARTICIPANTS',
          message: 'participants array is required',
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

    if (device.device_type !== 'admin') {
      await supabase
        .from('audit_log')
        .insert({
          action: 'admin_update_session_unauthorized',
          device_id: device.id,
          details: { session_id, participants_count: participants.length },
          created_at: serverNow,
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

    // Verify session exists and is active
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, court_id, started_at, actual_end_at')
      .eq('id', session_id)
      .single()

    if (sessionError || !session) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
      )
    }

    if (session.actual_end_at) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'SESSION_ENDED',
          message: 'Cannot update an ended session',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Calculate new scheduled_end_at
    let newScheduledEndAt: string
    if (scheduled_end_at === null) {
      // "No end time" -> set to midnight tonight
      const midnight = new Date()
      midnight.setHours(23, 59, 59, 999)
      newScheduledEndAt = midnight.toISOString()
    } else {
      newScheduledEndAt = scheduled_end_at
    }

    // Start transaction-like operations
    // 1. Delete existing participants
    const { error: deleteError } = await supabase
      .from('session_participants')
      .delete()
      .eq('session_id', session_id)

    if (deleteError) {
      throw new Error(`Failed to delete existing participants: ${deleteError.message}`)
    }

    // 2. Resolve participants and insert new ones
    const participantRecords = []

    for (const p of participants) {
      const name = (p.name || '').trim()
      if (!name) continue  // Skip empty names

      if (p.type === 'member' && p.member_id) {
        // Member with provided ID
        participantRecords.push({
          session_id,
          member_id: p.member_id,
          participant_type: 'member',
          guest_name: null,
        })
      } else if (p.type === 'member') {
        // Try to find member by name
        const { data: members } = await supabase
          .from('members')
          .select('id, display_name')
          .ilike('display_name', `%${name}%`)
          .limit(1)

        if (members && members.length > 0) {
          participantRecords.push({
            session_id,
            member_id: members[0].id,
            participant_type: 'member',
            guest_name: null,
          })
        } else {
          // Member not found, treat as guest with name
          participantRecords.push({
            session_id,
            member_id: null,
            participant_type: 'guest',
            guest_name: name,
          })
        }
      } else {
        // Guest
        participantRecords.push({
          session_id,
          member_id: null,
          participant_type: 'guest',
          guest_name: name,
        })
      }
    }

    if (participantRecords.length > 0) {
      const { error: insertError } = await supabase
        .from('session_participants')
        .insert(participantRecords)

      if (insertError) {
        throw new Error(`Failed to insert participants: ${insertError.message}`)
      }
    }

    // 3. Update session scheduled_end_at
    const { error: updateError } = await supabase
      .from('sessions')
      .update({ scheduled_end_at: newScheduledEndAt })
      .eq('id', session_id)

    if (updateError) {
      throw new Error(`Failed to update session: ${updateError.message}`)
    }

    // Signal board change for realtime update
    await signalBoardChange(supabase, 'session')

    // Audit log
    await supabase
      .from('audit_log')
      .insert({
        action: 'admin_update_session',
        entity_type: 'session',
        entity_id: session_id,
        device_id: device.id,
        device_type: device.device_type,
        request_data: {
          session_id,
          participants_count: participantRecords.length,
          scheduled_end_at: newScheduledEndAt,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // Fetch updated participants for response
    const { data: updatedParticipants } = await supabase
      .from('session_participants')
      .select(`
        participant_type,
        guest_name,
        members(display_name)
      `)
      .eq('session_id', session_id)

    const participantNames = (updatedParticipants || []).map((p: any) =>
      p.participant_type === 'member' ? p.members?.display_name : p.guest_name
    ).filter(Boolean)

    return new Response(
      JSON.stringify({
        ok: true,
        serverNow,
        session: {
          id: session_id,
          courtId: session.court_id,
          scheduledEndAt: newScheduledEndAt,
          participants: participantNames,
        },
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
