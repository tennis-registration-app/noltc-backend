import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { enforceGeofence } from "../_shared/geofenceCheck.ts"
import { endSession, signalBoardChange } from "../_shared/sessionLifecycle.ts"
import { generateParticipantKey } from "../_shared/participantKey.ts"
import {
  GROUP_TYPES,
  requireUuid,
  requireEnum,
  requireArray,
  requireString,
  isValidationError,
  verifyDevice,
  fetchBoardState,
  lookupDuration,
  createSessionWithFees,
  checkOperatingHours,
  corsHeaders,
  addCorsHeaders,
  successResponse,
  errorResponse,
  conflictResponse,
  internalErrorResponse,
} from "../_shared/index.ts"

interface Participant {
  type: 'member' | 'guest'
  member_id?: string
  guest_name?: string
  account_id: string
  charged_to_account_id?: string // For guest fees - which account pays
}

interface AssignCourtRequest {
  court_id: string
  session_type: 'singles' | 'doubles'
  participants: Participant[]
  device_id: string
  device_type: string
  add_balls?: boolean
  split_balls?: boolean
  initiated_by?: 'user' | 'ai_assistant'
  latitude?: number
  longitude?: number
  accuracy?: number  // GPS accuracy in meters
  location_token?: string  // QR-based location verification
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

  let requestData: AssignCourtRequest | null = null
  let auditEntityId = '00000000-0000-0000-0000-000000000000'

  try {
    requestData = await req.json() as AssignCourtRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    const body = requestData as unknown as Record<string, unknown>

    const courtIdResult = requireUuid(body, 'court_id')
    if (isValidationError(courtIdResult)) {
      throw new Error(courtIdResult.message)
    }
    const sessionTypeResult = requireEnum(body, 'session_type', GROUP_TYPES)
    if (isValidationError(sessionTypeResult)) {
      throw new Error(sessionTypeResult.message)
    }
    const participantsResult = requireArray(body, 'participants')
    if (isValidationError(participantsResult)) {
      throw new Error(participantsResult.message)
    }
    if (participantsResult.length === 0) {
      throw new Error('At least one participant is required')
    }
    const deviceIdResult = requireString(body, 'device_id')
    if (isValidationError(deviceIdResult)) {
      throw new Error(deviceIdResult.message)
    }

    // Validate participant count for session type
    const minPlayers = requestData.session_type === 'singles' ? 1 : 2
    const maxPlayers = requestData.session_type === 'singles' ? 3 : 4
    if (requestData.participants.length < minPlayers || requestData.participants.length > maxPlayers) {
      throw new Error(`${requestData.session_type} requires ${minPlayers}-${maxPlayers} participants`)
    }

    // Validate each participant
    for (const p of requestData.participants) {
      if (p.type === 'member' && !p.member_id) {
        throw new Error('member_id required for member participants')
      }
      if (p.type === 'guest' && !p.guest_name) {
        throw new Error('guest_name required for guest participants')
      }
      if (!p.account_id) {
        throw new Error('account_id required for all participants')
      }
    }

    // ===========================================
    // CHECK OPERATING HOURS
    // ===========================================

    const now = new Date()
    const dayOfWeek = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' })).getDay()
    await checkOperatingHours(supabase, serverNow)

    // ===========================================
    // VERIFY COURT EXISTS AND IS ACTIVE
    // ===========================================

    const { data: court, error: courtError } = await supabase
      .from('courts')
      .select('*')
      .eq('id', requestData.court_id)
      .single()

    if (courtError || !court) {
      throw new Error('Court not found')
    }
    if (!court.is_active) {
      throw new Error('Court is not active')
    }

    // Singles-only court restriction
    const SINGLES_ONLY_COURT_NUMBERS = [8]
    if (SINGLES_ONLY_COURT_NUMBERS.includes(court.court_number) && requestData.session_type !== 'singles') {
      throw new Error('Court 8 is singles only')
    }

    // ===========================================
    // VERIFY DEVICE EXISTS
    // ===========================================

    const device = await verifyDevice(supabase, requestData.device_id, serverNow)

    // ===========================================
    // GEOFENCE VALIDATION (mobile only)
    // ===========================================

    const firstMember = requestData.participants.find(p => p.type === 'member')
    const { geofenceStatus, geoVerifiedMethod } = await enforceGeofence(supabase, {
      deviceType: device.device_type,
      deviceId: requestData.device_id,
      initiatedBy: requestData.initiated_by,
      latitude: requestData.latitude,
      longitude: requestData.longitude,
      accuracy: requestData.accuracy,
      locationToken: requestData.location_token,
      memberId: firstMember?.member_id,
      serverNow,
      auditAction: 'session_start',
      auditRequestData: {},
      ipAddress: req.headers.get('x-forwarded-for') || 'unknown',
    })

    // ===========================================
    // CHECK COURT AVAILABILITY (with lock)
    // ===========================================

    // Track displaced session for potential restore
    let displacedSessionId: string | null = null
    let displacedCourtId: string | null = null
    let displacedPlayerNames: string[] = []

    // Pre-generate session ID so we can reference it in the END event for displaced sessions
    const newSessionId = crypto.randomUUID()

    // Check for active sessions (may be multiple if data is stale)
    const { data: activeSessions, error: sessionQueryError } = await supabase
      .from('sessions')
      .select('id, scheduled_end_at')
      .eq('court_id', requestData.court_id)
      .is('actual_end_at', null)
      .order('started_at', { ascending: false })

    if (sessionQueryError) {
      console.error('Error querying active sessions:', sessionQueryError)
    }

    // End ALL stale sessions on this court before proceeding
    if (activeSessions && activeSessions.length > 0) {
      // Get the most recent session for overtime check
      const activeSession = activeSessions[0]
      // Check if session is in overtime (scheduled_end_at is in the past)
      const scheduledEnd = new Date(activeSession.scheduled_end_at)
      const isOvertime = scheduledEnd < now

      if (isOvertime) {
        // Capture the displaced session ID before ending (for potential restore)
        displacedSessionId = activeSessions[0].id
        displacedCourtId = requestData.court_id

        // Fetch participants for the displaced session before ending it
        const { data: displacedParticipants } = await supabase
          .from('session_participants')
          .select(`
            participant_type,
            guest_name,
            members(display_name)
          `)
          .eq('session_id', displacedSessionId)

        displacedPlayerNames = displacedParticipants?.map(p =>
          p.participant_type === 'member' ? p.members?.display_name : p.guest_name
        ).filter(Boolean) || []

        // End ALL overtime/stale sessions on this court
        for (const session of activeSessions) {
          const endResult = await endSession(supabase, {
            sessionId: session.id,
            serverNow,
            endReason: 'overtime_takeover',
            deviceId: requestData.device_id,
            eventData: {
              trigger: activeSessions.length > 1 ? 'stale_session_cleanup' : 'overtime_takeover',
              takeover_session_id: newSessionId, // Reference to the session being created
            },
          })

          if (!endResult.success && !endResult.alreadyEnded) {
            console.error(`Failed to end session ${session.id}:`, endResult.error)
            // Continue trying to end other sessions
          }
        }
      } else {
        throw new Error('Court is currently occupied')
      }
    }

    // Check for active block
    const { data: activeBlock } = await supabase
      .from('blocks')
      .select('id, title, block_type')
      .eq('court_id', requestData.court_id)
      .is('cancelled_at', null)
      .lte('starts_at', now.toISOString())
      .gt('ends_at', now.toISOString())
      .single()

    if (activeBlock) {
      throw new Error(`Court is blocked: ${activeBlock.title}`)
    }

    // ===========================================
    // CHECK IF ANY MEMBER IS ALREADY PLAYING
    // ===========================================

    const memberIds = requestData.participants
      .filter(p => p.type === 'member' && p.member_id)
      .map(p => p.member_id)

    if (memberIds.length > 0) {
      // Query for any active sessions containing these members
      const { data: activeSessions } = await supabase
        .from('session_participants')
        .select(`
          member_id,
          sessions!inner(id, court_id, actual_end_at),
          members(display_name)
        `)
        .in('member_id', memberIds)
        .is('sessions.actual_end_at', null)

      if (activeSessions && activeSessions.length > 0) {
        // Find the first conflicting member
        const conflict = activeSessions[0]
        const memberName = conflict.members?.display_name || 'Member'

        // Get court number for the error message
        const { data: conflictCourt } = await supabase
          .from('courts')
          .select('court_number')
          .eq('id', conflict.sessions.court_id)
          .single()

        const courtNum = conflictCourt?.court_number || '?'

        return addCorsHeaders(
          conflictResponse(
            'MEMBER_ALREADY_PLAYING',
            `${memberName} is already playing on Court ${courtNum}`,
            serverNow
          )
        )
      }

      // Check for members already on waitlist
      const { data: waitlistPlayers, error: waitlistError } = await supabase
        .from('waitlist_participants')
        .select(`
          member_id,
          waitlist_entry:waitlist_entries!inner(id, status),
          members(display_name)
        `)
        .in('member_id', memberIds)
        .eq('waitlist_entry.status', 'waiting')

      if (waitlistError) {
        console.error('Error checking waitlist:', waitlistError)
      }

      if (waitlistPlayers && waitlistPlayers.length > 0) {
        const conflict = waitlistPlayers[0]
        const memberName = conflict.members?.display_name || 'Member'

        return addCorsHeaders(
          conflictResponse(
            'MEMBER_ALREADY_ON_WAITLIST',
            `${memberName} is already on the waitlist`,
            serverNow
          )
        )
      }
    }

    // ===========================================
    // CHECK FOR RE-REGISTRATION (same group cleared early)
    // ===========================================

    const participantKey = generateParticipantKey(requestData.participants);
    let inheritedEndTime: Date | null = null;

    if (participantKey) {
      const { data: previousSession } = await supabase
        .from('sessions')
        .select('id, scheduled_end_at, actual_end_at')
        .eq('participant_key', participantKey)
        .not('actual_end_at', 'is', null)  // Session was ended/cleared
        .gt('scheduled_end_at', new Date().toISOString())  // Original end time still in future
        .order('actual_end_at', { ascending: false })  // Most recent first
        .limit(1)
        .maybeSingle();

      if (previousSession) {
        inheritedEndTime = new Date(previousSession.scheduled_end_at);
      }
    }

    // ===========================================
    // GET DURATION FROM SETTINGS
    // ===========================================

    const durationMinutes = await lookupDuration(supabase, requestData.session_type)

    // ===========================================
    // CREATE SESSION
    // ===========================================

    const startedAt = new Date()
    const newEndTime = new Date(startedAt.getTime() + durationMinutes * 60 * 1000)
    const scheduledEndAt = inheritedEndTime
      ? new Date(Math.min(newEndTime.getTime(), inheritedEndTime.getTime()))
      : newEndTime

    // Get registrant member_id (first member in participants list)
    const registrantMemberId = requestData.participants.find(p => p.type === 'member')?.member_id || null

    // ===========================================
    // CREATE SESSION, PARTICIPANTS, AND TRANSACTIONS (ATOMIC RPC)
    // ===========================================

    const { data: rpcResult, error: rpcError } = await createSessionWithFees(supabase, {
      sessionId: newSessionId,
      courtId: requestData.court_id,
      sessionType: requestData.session_type,
      durationMinutes,
      startedAt: startedAt.toISOString(),
      scheduledEndAt: scheduledEndAt.toISOString(),
      deviceId: requestData.device_id,
      participantKey,
      registeredByMemberId: registrantMemberId,
      participants: requestData.participants.map(p => ({
        member_id: p.type === 'member' ? (p.member_id ?? null) : null,
        guest_name: p.type === 'guest' ? (p.guest_name ?? null) : null,
        participant_type: p.type,
        account_id: p.account_id,
        charged_to_account_id: p.charged_to_account_id ?? null,
      })),
      dayOfWeek,
      addBalls: requestData.add_balls || false,
      splitBalls: requestData.split_balls || false,
    })

    if (rpcError || !rpcResult) {
      throw new Error(`Failed to create session: ${rpcError?.message}`)
    }

    const session = {
      id: rpcResult.session_id as string,
      court_id: requestData.court_id,
      session_type: requestData.session_type,
      duration_minutes: durationMinutes,
      started_at: startedAt.toISOString(),
      scheduled_end_at: scheduledEndAt.toISOString(),
    }

    auditEntityId = session.id

    // Calculate restoreUntil for displaced session (30 seconds from now)
    const restoreUntil = displacedSessionId
      ? new Date(new Date(serverNow).getTime() + 30000).toISOString()
      : null

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'session_start',
        entity_type: 'session',
        entity_id: session.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        account_id: requestData.participants[0].account_id,
        request_data: {
          court_number: court.court_number,
          session_type: requestData.session_type,
          participant_count: requestData.participants.length,
          add_balls: requestData.add_balls || false,
          split_balls: requestData.split_balls || false,
          geo_verified_method: geoVerifiedMethod,
          accuracy: requestData.accuracy,
        },
        outcome: 'success',
        geofence_status: geofenceStatus,
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    // Fetch participants for response
    const { data: sessionParticipants } = await supabase
      .from('session_participants')
      .select(`
        participant_type,
        guest_name,
        members(display_name)
      `)
      .eq('session_id', session.id)

    const participantNames = sessionParticipants?.map(p =>
      p.participant_type === 'member' ? p.members?.display_name : p.guest_name
    ).filter(Boolean) || []


    // Signal board change for real-time updates (db insert + broadcast)
    await signalBoardChange(supabase, 'session');

    // Fetch updated board state so frontend can apply without a separate refetch
    const board = await fetchBoardState(supabase, 'assign-court');

    return addCorsHeaders(
      successResponse(
        {
          session: {
            id: session.id,
            court_id: session.court_id,
            court_number: court.court_number,
            court_name: court.name,
            session_type: session.session_type,
            duration_minutes: session.duration_minutes,
            started_at: session.started_at,
            scheduled_end_at: session.scheduled_end_at,
            participants: participantNames,
          },
          displacement: displacedSessionId ? {
            displacedSessionId,
            displacedCourtId,
            takeoverSessionId: session.id,
            restoreUntil,
            participants: displacedPlayerNames,
          } : null,
          timeLimitReason: inheritedEndTime ? 'rereg' : null,
          isInheritedEndTime: !!inheritedEndTime,
          inheritedFromScheduledEnd: inheritedEndTime?.toISOString() || null,
          board,
        },
        serverNow
      )
    )

  } catch (error) {
    // Audit log - failure
    await supabase
      .from('audit_log')
      .insert({
        action: 'session_start',
        entity_type: 'session',
        entity_id: auditEntityId,
        device_id: requestData?.device_id || null,
        device_type: requestData?.device_type || null,
        initiated_by: requestData?.initiated_by || 'user',
        request_data: requestData,
        outcome: 'failure',
        error_message: error.message,
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    console.error('Unexpected error in assign-court:', error)
    return addCorsHeaders(
      internalErrorResponse(error.message, serverNow)
    )
  }
})

