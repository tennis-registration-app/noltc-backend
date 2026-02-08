import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { validateGeofence } from "../_shared/geofence.ts"
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Participant {
  type: 'member' | 'guest'
  member_id?: string
  guest_name?: string
  account_id: string
}

interface JoinWaitlistRequest {
  group_type: 'singles' | 'doubles'
  participants: Participant[]
  device_id: string
  device_type: string
  initiated_by?: 'user' | 'ai_assistant'
  latitude?: number
  longitude?: number
  deferred?: boolean
}

// Denial codes for expected business rule failures (HTTP 200)
type DenialCode =
  | 'INVALID_GROUP_TYPE'
  | 'NO_PARTICIPANTS'
  | 'INVALID_PARTICIPANT_COUNT'
  | 'INVALID_PARTICIPANT'
  | 'MISSING_DEVICE_ID'
  | 'DEVICE_NOT_REGISTERED'
  | 'CLUB_CLOSED'
  | 'OUTSIDE_HOURS'
  | 'LOCATION_REQUIRED'
  | 'GEOFENCE_FAILED'
  | 'ALREADY_ON_WAITLIST'
  | 'WAITLIST_CREATE_FAILED'
  | 'PARTICIPANTS_CREATE_FAILED'

/**
 * Standard success response with CORS
 */
function successResponse(data: Record<string, unknown>, serverNow: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    code: 'OK',
    message: '',
    serverNow,
    data,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 200,
  })
}

/**
 * Standard denial response (expected business rule failure) with CORS
 * Returns HTTP 200 - this is an expected denial, not an error
 */
function denialResponse(code: DenialCode, message: string, serverNow: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    code,
    message,
    serverNow,
    data: null,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 200,
  })
}

/**
 * Internal error response (unexpected failure) with CORS
 * Returns HTTP 500
 */
function internalErrorResponse(message: string, serverNow: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    code: 'INTERNAL_ERROR',
    message,
    serverNow,
    data: null,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 500,
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Consistent timestamp for the entire request
  const serverNow = new Date().toISOString()

  let requestData: JoinWaitlistRequest | null = null
  let waitlistId = '00000000-0000-0000-0000-000000000000'

  try {
    requestData = await req.json() as JoinWaitlistRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.group_type || !['singles', 'doubles'].includes(requestData.group_type)) {
      return denialResponse('INVALID_GROUP_TYPE', 'group_type must be "singles" or "doubles"', serverNow)
    }
    if (!requestData.participants || requestData.participants.length === 0) {
      return denialResponse('NO_PARTICIPANTS', 'At least one participant is required', serverNow)
    }
    if (!requestData.device_id) {
      return denialResponse('MISSING_DEVICE_ID', 'device_id is required', serverNow)
    }

    // Validate participant count for group type
    const minPlayers = requestData.group_type === 'singles' ? 1 : 2
    const maxPlayers = requestData.group_type === 'singles' ? 3 : 4
    if (requestData.participants.length < minPlayers || requestData.participants.length > maxPlayers) {
      return denialResponse(
        'INVALID_PARTICIPANT_COUNT',
        `${requestData.group_type} requires ${minPlayers}-${maxPlayers} participants`,
        serverNow
      )
    }

    // Validate each participant
    for (const p of requestData.participants) {
      if (p.type === 'member' && !p.member_id) {
        return denialResponse('INVALID_PARTICIPANT', 'member_id required for member participants', serverNow)
      }
      if (p.type === 'guest' && !p.guest_name) {
        return denialResponse('INVALID_PARTICIPANT', 'guest_name required for guest participants', serverNow)
      }
      if (!p.account_id) {
        return denialResponse('INVALID_PARTICIPANT', 'account_id required for all participants', serverNow)
      }
    }

    // ===========================================
    // CHECK OPERATING HOURS
    // ===========================================

    // Convert current UTC time to Central Time (America/Chicago)
    const now = new Date()
    const centralTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
    const dayOfWeek = centralTime.getDay() // 0 = Sunday
    const hours = centralTime.getHours().toString().padStart(2, '0')
    const minutes = centralTime.getMinutes().toString().padStart(2, '0')
    const seconds = centralTime.getSeconds().toString().padStart(2, '0')
    const currentTime = `${hours}:${minutes}:${seconds}` // HH:MM:SS format
    const today = centralTime.toISOString().slice(0, 10) // YYYY-MM-DD

    // Check for override first
    const { data: override } = await supabase
      .from('operating_hours_overrides')
      .select('*')
      .eq('date', today)
      .single()

    let opensAt = ''
    let closesAt = ''

    if (override) {
      if (override.is_closed) {
        return denialResponse('CLUB_CLOSED', 'The club is closed today', serverNow)
      }
      opensAt = override.opens_at
      closesAt = override.closes_at
    } else {
      const { data: hoursData, error: hoursError } = await supabase
        .from('operating_hours')
        .select('*')
        .eq('day_of_week', dayOfWeek)
        .single()

      if (hoursError || !hoursData) {
        return internalErrorResponse('Could not determine operating hours', serverNow)
      }

      if (hoursData.is_closed) {
        return denialResponse('CLUB_CLOSED', 'The club is closed today', serverNow)
      }
      opensAt = hoursData.opens_at
      closesAt = hoursData.closes_at
    }

    if (currentTime < opensAt) {
      return denialResponse('OUTSIDE_HOURS', `Registration opens at ${opensAt.slice(0, 5)}`, serverNow)
    }
    if (currentTime >= closesAt) {
      return denialResponse('OUTSIDE_HOURS', `Registration is closed for today (closed at ${closesAt.slice(0, 5)})`, serverNow)
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
      return denialResponse('DEVICE_NOT_REGISTERED', 'Device not registered', serverNow)
    }

    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    // ===========================================
    // GEOFENCE VALIDATION (mobile only)
    // ===========================================

    let geofenceStatus: 'validated' | 'failed' | 'not_required' = 'not_required'

    if (device.device_type === 'mobile') {
      if (!requestData.latitude || !requestData.longitude) {
        return denialResponse('LOCATION_REQUIRED', 'Location required for mobile registration', serverNow)
      }

      const geofenceResult = await validateGeofence(
        supabase,
        requestData.latitude,
        requestData.longitude
      )

      geofenceStatus = geofenceResult.isValid ? 'validated' : 'failed'

      if (!geofenceResult.isValid) {
        // Log the failed attempt
        await supabase.from('audit_log').insert({
          action: 'waitlist_join',
          entity_type: 'waitlist',
          entity_id: '00000000-0000-0000-0000-000000000000',
          device_id: requestData.device_id,
          device_type: requestData.device_type,
          initiated_by: requestData.initiated_by || 'user',
          request_data: {
            latitude: requestData.latitude,
            longitude: requestData.longitude,
            distance: geofenceResult.distance,
            threshold: geofenceResult.threshold,
          },
          outcome: 'denied',
          error_message: geofenceResult.message,
          geofence_status: 'failed',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })

        return denialResponse('GEOFENCE_FAILED', geofenceResult.message, serverNow)
      }
    }

    // ===========================================
    // CHECK IF MEMBER ALREADY IN WAITLIST
    // ===========================================

    const memberIds = requestData.participants
      .filter(p => p.type === 'member' && p.member_id)
      .map(p => p.member_id)

    if (memberIds.length > 0) {
      const { data: existingEntries } = await supabase
        .from('waitlist_members')
        .select(`
          member_id,
          waitlist!inner(status)
        `)
        .in('member_id', memberIds)
        .eq('waitlist.status', 'waiting')

      if (existingEntries && existingEntries.length > 0) {
        return denialResponse('ALREADY_ON_WAITLIST', 'One or more members are already on the waitlist', serverNow)
      }
    }

    // ===========================================
    // GET NEXT POSITION
    // ===========================================

    const { data: lastEntry } = await supabase
      .from('waitlist')
      .select('position')
      .eq('status', 'waiting')
      .order('position', { ascending: false })
      .limit(1)
      .single()

    const nextPosition = lastEntry ? lastEntry.position + 1 : 1

    // ===========================================
    // CREATE WAITLIST ENTRY
    // ===========================================

    const { data: waitlistEntry, error: waitlistError } = await supabase
      .from('waitlist')
      .insert({
        group_type: requestData.group_type,
        position: nextPosition,
        status: 'waiting',
        joined_at: now.toISOString(),
        created_by_device_id: requestData.device_id,
        deferred: requestData.deferred ?? false,
      })
      .select()
      .single()

    if (waitlistError || !waitlistEntry) {
      console.error('Failed to create waitlist entry:', waitlistError)
      return internalErrorResponse(`Failed to create waitlist entry: ${waitlistError?.message}`, serverNow)
    }

    waitlistId = waitlistEntry.id

    // ===========================================
    // ADD PARTICIPANTS
    // ===========================================

    const participantRecords = requestData.participants.map(p => ({
      waitlist_id: waitlistEntry.id,
      member_id: p.type === 'member' ? p.member_id : null,
      guest_name: p.type === 'guest' ? p.guest_name : null,
      participant_type: p.type,
      account_id: p.account_id,
    }))

    const { error: participantsError } = await supabase
      .from('waitlist_members')
      .insert(participantRecords)

    if (participantsError) {
      console.error('Failed to add participants:', participantsError)
      return internalErrorResponse(`Failed to add participants: ${participantsError.message}`, serverNow)
    }

    // ===========================================
    // GET PARTICIPANT NAMES FOR RESPONSE
    // ===========================================

    const participantNames: string[] = []
    for (const p of requestData.participants) {
      if (p.type === 'guest') {
        participantNames.push(p.guest_name!)
      } else {
        const { data: member } = await supabase
          .from('members')
          .select('display_name')
          .eq('id', p.member_id)
          .single()
        participantNames.push(member?.display_name || 'Unknown')
      }
    }

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'waitlist_join',
        entity_type: 'waitlist',
        entity_id: waitlistEntry.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        account_id: requestData.participants[0].account_id,
        request_data: {
          group_type: requestData.group_type,
          position: nextPosition,
          participant_count: requestData.participants.length,
        },
        outcome: 'success',
        geofence_status: geofenceStatus,
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    // Signal board change for real-time updates (db insert + broadcast)
    await signalBoardChange(supabase, 'waitlist');

    return successResponse({
      waitlist: {
        id: waitlistEntry.id,
        group_type: waitlistEntry.group_type,
        position: waitlistEntry.position,
        status: waitlistEntry.status,
        joined_at: waitlistEntry.joined_at,
        participants: participantNames,
      },
    }, serverNow)

  } catch (error) {
    // Audit log - failure (unexpected error)
    await supabase
      .from('audit_log')
      .insert({
        action: 'waitlist_join',
        entity_type: 'waitlist',
        entity_id: waitlistId,
        device_id: requestData?.device_id || null,
        device_type: requestData?.device_type || null,
        initiated_by: requestData?.initiated_by || 'user',
        request_data: requestData,
        outcome: 'failure',
        error_message: error.message,
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    console.error('Unexpected error in join-waitlist:', error)
    return internalErrorResponse(error.message, serverNow)
  }
})
