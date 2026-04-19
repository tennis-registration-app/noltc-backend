import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { validateGeofence } from "../_shared/geofence.ts"
import { signalBoardChange } from "../_shared/sessionLifecycle.ts"
import {
  corsHeaders,
  addCorsHeaders,
  successResponse,
  errorResponse,
  conflictResponse,
  internalErrorResponse,
  checkOperatingHours,
} from "../_shared/index.ts"

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
      return addCorsHeaders(errorResponse('INVALID_GROUP_TYPE', 'group_type must be "singles" or "doubles"', serverNow, 400))
    }
    if (!requestData.participants || requestData.participants.length === 0) {
      return addCorsHeaders(errorResponse('NO_PARTICIPANTS', 'At least one participant is required', serverNow, 400))
    }
    if (!requestData.device_id) {
      return addCorsHeaders(errorResponse('MISSING_DEVICE_ID', 'device_id is required', serverNow, 400))
    }

    // Validate participant count for group type
    const minPlayers = requestData.group_type === 'singles' ? 1 : 2
    const maxPlayers = requestData.group_type === 'singles' ? 3 : 4
    if (requestData.participants.length < minPlayers || requestData.participants.length > maxPlayers) {
      return addCorsHeaders(errorResponse(
        'INVALID_PARTICIPANT_COUNT',
        `${requestData.group_type} requires ${minPlayers}-${maxPlayers} participants`,
        serverNow,
        400
      ))
    }

    // Validate each participant
    for (const p of requestData.participants) {
      if (p.type === 'member' && !p.member_id) {
        return addCorsHeaders(errorResponse('INVALID_PARTICIPANT', 'member_id required for member participants', serverNow, 400))
      }
      if (p.type === 'guest' && !p.guest_name) {
        return addCorsHeaders(errorResponse('INVALID_PARTICIPANT', 'guest_name required for guest participants', serverNow, 400))
      }
      if (!p.account_id) {
        return addCorsHeaders(errorResponse('INVALID_PARTICIPANT', 'account_id required for all participants', serverNow, 400))
      }
    }

    // ===========================================
    // CHECK OPERATING HOURS
    // ===========================================

    const now = new Date()
    await checkOperatingHours(supabase, serverNow)

    // ===========================================
    // VERIFY DEVICE EXISTS
    // ===========================================

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      return addCorsHeaders(errorResponse('DEVICE_NOT_REGISTERED', 'Device not registered', serverNow, 400))
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
        return addCorsHeaders(errorResponse('LOCATION_REQUIRED', 'Location required for mobile registration', serverNow, 400))
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

        return addCorsHeaders(errorResponse('GEOFENCE_FAILED', geofenceResult.message, serverNow, 400))
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
        return addCorsHeaders(conflictResponse('ALREADY_ON_WAITLIST', 'One or more members are already on the waitlist', serverNow))
      }
    }

    // ===========================================
    // CREATE WAITLIST ENTRY + MEMBERS (ATOMIC RPC)
    // ===========================================
    //
    // The RPC assigns the next position, inserts the waitlist row, and
    // inserts all waitlist_members in a single transaction. An advisory
    // lock inside the RPC serializes concurrent position assignments so
    // two requests can't race into the same position.

    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      'create_waitlist_entry',
      {
        p_group_type: requestData.group_type,
        p_joined_at: now.toISOString(),
        p_created_by_device_id: requestData.device_id,
        p_deferred: requestData.deferred ?? false,
        p_participants: requestData.participants.map(p => ({
          member_id: p.type === 'member' ? p.member_id : '',
          guest_name: p.type === 'guest' ? p.guest_name : '',
          participant_type: p.type,
          account_id: p.account_id,
        })),
      }
    )

    if (rpcError) {
      console.error('create_waitlist_entry RPC error:', rpcError)
      return addCorsHeaders(internalErrorResponse(`Failed to create waitlist entry: ${rpcError.message}`, serverNow))
    }

    if (!rpcResult?.success) {
      console.error('create_waitlist_entry failed:', rpcResult?.error)
      return addCorsHeaders(internalErrorResponse(`Failed to create waitlist entry: ${rpcResult?.error ?? 'unknown error'}`, serverNow))
    }

    waitlistId = rpcResult.waitlist_id
    const assignedPosition = rpcResult.position

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
        entity_id: waitlistId,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        account_id: requestData.participants[0].account_id,
        request_data: {
          group_type: requestData.group_type,
          position: assignedPosition,
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

    return addCorsHeaders(successResponse({
      data: {
        waitlist: {
          id: waitlistId,
          group_type: requestData.group_type,
          position: assignedPosition,
          status: 'waiting',
          joined_at: now.toISOString(),
          participants: participantNames,
        },
      },
    }, serverNow))

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
    return addCorsHeaders(internalErrorResponse(error.message, serverNow))
  }
})
