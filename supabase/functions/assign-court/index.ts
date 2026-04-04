import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { validateGeofence, validateLocationToken } from "../_shared/geofence.ts"
import { endSession, signalBoardChange } from "../_shared/sessionLifecycle.ts"
import { generateParticipantKey } from "../_shared/participantKey.ts"
import {
  GROUP_TYPES,
  requireUuid,
  requireEnum,
  requireArray,
  requireString,
  isValidationError,
  successResponse,
  errorResponse,
  conflictResponse,
  internalErrorResponse,
} from "../_shared/index.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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

    let isOpen = false
    let opensAt = ''
    let closesAt = ''

    if (override) {
      if (override.is_closed) {
        throw new Error('The club is closed today')
      }
      opensAt = override.opens_at
      closesAt = override.closes_at
    } else {
      // Get regular hours
      const { data: hoursData, error: hoursError } = await supabase
        .from('operating_hours')
        .select('*')
        .eq('day_of_week', dayOfWeek)
        .single()

      if (hoursError || !hoursData) {
        throw new Error('Could not determine operating hours')
      }

      if (hoursData.is_closed) {
        throw new Error('The club is closed today')
      }
      opensAt = hoursData.opens_at
      closesAt = hoursData.closes_at
    }

    if (currentTime < opensAt) {
      throw new Error(`Registration opens at ${opensAt.slice(0, 5)}`)
    }
    if (currentTime >= closesAt) {
      throw new Error(`Registration is closed for today (closed at ${closesAt.slice(0, 5)})`)
    }

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

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      throw new Error('Device not registered')
    }

    // Update device last_seen_at
    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    // ===========================================
    // GEOFENCE VALIDATION (mobile only)
    // ===========================================

    let geofenceStatus: 'validated' | 'failed' | 'not_required' = 'not_required'
    let geoVerifiedMethod: 'gps' | 'qr' | null = null

    if (device.device_type === 'mobile') {
      const hasGps = requestData.latitude && requestData.longitude
      const hasToken = requestData.location_token

      if (hasGps) {
        // GPS-based validation
        const geofenceResult = await validateGeofence(
          supabase,
          requestData.latitude!,
          requestData.longitude!
        )

        geofenceStatus = geofenceResult.isValid ? 'validated' : 'failed'

        if (geofenceResult.isValid) {
          geoVerifiedMethod = 'gps'
        } else {
          // Log the failed GPS attempt
          await supabase.from('audit_log').insert({
            action: 'session_start',
            entity_type: 'session',
            entity_id: '00000000-0000-0000-0000-000000000000',
            device_id: requestData.device_id,
            device_type: requestData.device_type,
            initiated_by: requestData.initiated_by || 'user',
            request_data: {
              latitude: requestData.latitude,
              longitude: requestData.longitude,
              accuracy: requestData.accuracy,
              distance: geofenceResult.distance,
              threshold: geofenceResult.threshold,
              geo_verified_method: 'gps',
            },
            outcome: 'denied',
            error_message: geofenceResult.message,
            geofence_status: 'failed',
            ip_address: req.headers.get('x-forwarded-for') || 'unknown',
          })

          throw new Error(geofenceResult.message)
        }
      } else if (hasToken) {
        // QR token-based validation
        // Get first member's ID for token validation
        const firstMember = requestData.participants.find(p => p.type === 'member')
        const memberId = firstMember?.member_id || '00000000-0000-0000-0000-000000000000'

        const tokenResult = await validateLocationToken(
          supabase,
          requestData.location_token!,
          memberId,
          requestData.device_id
        )

        geofenceStatus = tokenResult.isValid ? 'validated' : 'failed'

        if (tokenResult.isValid) {
          geoVerifiedMethod = 'qr'
        } else {
          // Log the failed token attempt
          await supabase.from('audit_log').insert({
            action: 'session_start',
            entity_type: 'session',
            entity_id: '00000000-0000-0000-0000-000000000000',
            device_id: requestData.device_id,
            device_type: requestData.device_type,
            initiated_by: requestData.initiated_by || 'user',
            request_data: {
              location_token: requestData.location_token,
              token_id: tokenResult.tokenId,
              geo_verified_method: 'qr',
            },
            outcome: 'denied',
            error_message: tokenResult.message,
            geofence_status: 'failed',
            ip_address: req.headers.get('x-forwarded-for') || 'unknown',
          })

          throw new Error(tokenResult.message)
        }
      } else {
        // Neither GPS nor token provided
        throw new Error('Location required for mobile registration')
      }
    }

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
    console.log(`[assign-court] Checking for active sessions on court ${requestData.court_id}`)
    const { data: activeSessions, error: sessionQueryError } = await supabase
      .from('sessions')
      .select('id, scheduled_end_at')
      .eq('court_id', requestData.court_id)
      .is('actual_end_at', null)
      .order('started_at', { ascending: false })

    console.log(`[assign-court] Active sessions query result:`, {
      count: activeSessions?.length ?? 0,
      sessionIds: activeSessions?.map(s => s.id) ?? [],
      error: sessionQueryError?.message ?? null,
    })

    if (sessionQueryError) {
      console.error('Error querying active sessions:', sessionQueryError)
    }

    // End ALL stale sessions on this court before proceeding
    if (activeSessions && activeSessions.length > 0) {
      // Log if there are multiple (indicates stale data issue)
      if (activeSessions.length > 1) {
        console.warn(`⚠️ Found ${activeSessions.length} active sessions on court ${requestData.court_id} - cleaning up stale sessions`)
      }

      // Get the most recent session for overtime check
      const activeSession = activeSessions[0]
      // Check if session is in overtime (scheduled_end_at is in the past)
      const scheduledEnd = new Date(activeSession.scheduled_end_at)
      const isOvertime = scheduledEnd < now
      const minutesRemaining = (scheduledEnd.getTime() - now.getTime()) / (1000 * 60)

      console.log(`🔍 Court availability check for court ${requestData.court_id}:`, {
        sessionId: activeSession.id,
        scheduledEnd: activeSession.scheduled_end_at,
        scheduledEndMs: scheduledEnd.getTime(),
        nowMs: now.getTime(),
        nowISO: now.toISOString(),
        minutesRemaining: minutesRemaining.toFixed(2),
        isOvertime,
      })

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
        console.log(`Ending ${activeSessions.length} session(s) for court takeover`)
        for (const session of activeSessions) {
          console.log(`  Ending session ${session.id}`)
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
          } else {
            console.log(`  ✅ Ended session ${session.id}`)
          }
        }
      } else {
        console.log(`❌ Rejecting: Court has ${minutesRemaining.toFixed(2)} minutes remaining`)
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
        console.log('[assign-court] Re-registration detected, participant_key:', participantKey);
        console.log('[assign-court] Inheriting end time from session:', previousSession.id, inheritedEndTime.toISOString());
      }
    }

    // ===========================================
    // GET DURATION FROM SETTINGS
    // ===========================================

    const durationKey = requestData.session_type === 'singles'
      ? 'singles_duration_minutes'
      : 'doubles_duration_minutes'

    const { data: durationSetting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', durationKey)
      .single()

    const durationMinutes = durationSetting ? parseInt(durationSetting.value) : (requestData.session_type === 'singles' ? 60 : 90)

    // ===========================================
    // CREATE SESSION
    // ===========================================

    const startedAt = new Date()
    const newEndTime = new Date(startedAt.getTime() + durationMinutes * 60 * 1000)
    const scheduledEndAt = inheritedEndTime
      ? new Date(Math.min(newEndTime.getTime(), inheritedEndTime.getTime()))
      : newEndTime

    console.log(`[assign-court] About to create new session on court ${requestData.court_id}`, {
      displacedSessionId,
      displacedCourtId,
      startedAt: startedAt.toISOString(),
    })

    // Get registrant member_id (first member in participants list)
    const registrantMemberId = requestData.participants.find(p => p.type === 'member')?.member_id || null

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({
        id: newSessionId, // Use pre-generated ID for traceability
        court_id: requestData.court_id,
        session_type: requestData.session_type,
        duration_minutes: durationMinutes,
        started_at: startedAt.toISOString(),
        scheduled_end_at: scheduledEndAt.toISOString(),
        created_by_device_id: requestData.device_id,
        participant_key: participantKey,
        registered_by_member_id: registrantMemberId,
      })
      .select()
      .single()

    if (sessionError || !session) {
      console.error(`[assign-court] Failed to create session:`, sessionError)
      throw new Error(`Failed to create session: ${sessionError?.message}`)
    }

    console.log(`[assign-court] ✅ Session created successfully:`, {
      sessionId: session.id,
      courtId: session.court_id,
    })

    auditEntityId = session.id

    // Calculate restoreUntil for displaced session (30 seconds from now)
    const restoreUntil = displacedSessionId
      ? new Date(new Date(serverNow).getTime() + 30000).toISOString()
      : null

    // ===========================================
    // CREATE PARTICIPANTS
    // ===========================================

    const participantRecords = requestData.participants.map(p => ({
      session_id: session.id,
      member_id: p.type === 'member' ? p.member_id : null,
      guest_name: p.type === 'guest' ? p.guest_name : null,
      participant_type: p.type,
      account_id: p.account_id,
    }))

    const { error: participantsError } = await supabase
      .from('session_participants')
      .insert(participantRecords)

    if (participantsError) {
      throw new Error(`Failed to add participants: ${participantsError.message}`)
    }

    // ===========================================
    // PROCESS GUEST FEES
    // ===========================================

    const guests = requestData.participants.filter(p => p.type === 'guest')

    if (guests.length > 0) {
      // Determine if weekend
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
      const feeKey = isWeekend ? 'guest_fee_weekend_cents' : 'guest_fee_weekday_cents'

      const { data: feeSetting } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', feeKey)
        .single()

      const guestFeeCents = feeSetting ? parseInt(feeSetting.value) : (isWeekend ? 2000 : 1500)

      for (const guest of guests) {
        const chargeToAccount = guest.charged_to_account_id || guest.account_id

        await supabase
          .from('transactions')
          .insert({
            account_id: chargeToAccount,
            transaction_type: 'guest_fee',
            amount_cents: guestFeeCents,
            description: `Guest fee for ${guest.guest_name}`,
            session_id: session.id,
            created_by_device_id: requestData.device_id,
          })
      }
    }

    // ===========================================
    // PROCESS BALL PURCHASE
    // ===========================================

    if (requestData.add_balls) {
      const { data: ballSetting } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'ball_price_cents')
        .single()

      const ballPriceCents = ballSetting ? parseInt(ballSetting.value) : 500

      // Get member participants only (for splitting)
      const memberParticipants = requestData.participants.filter(p => p.type === 'member')

      if (requestData.split_balls && memberParticipants.length > 1) {
        // Split among members (round up)
        const splitAmount = Math.ceil(ballPriceCents / memberParticipants.length)

        for (const member of memberParticipants) {
          await supabase
            .from('transactions')
            .insert({
              account_id: member.account_id,
              transaction_type: 'ball_purchase',
              amount_cents: splitAmount,
              description: `Tennis balls (split ${memberParticipants.length} ways)`,
              session_id: session.id,
              created_by_device_id: requestData.device_id,
            })
        }
      } else {
        // Charge to first participant's account (the registering member)
        const registeringAccount = requestData.participants[0].account_id

        await supabase
          .from('transactions')
          .insert({
            account_id: registeringAccount,
            transaction_type: 'ball_purchase',
            amount_cents: ballPriceCents,
            description: 'Tennis balls',
            session_id: session.id,
            created_by_device_id: requestData.device_id,
          })
      }
    }

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
    let board: Record<string, unknown> | null = null;
    try {
      const boardNow = new Date().toISOString();
      const [courtsResult, waitlistResult, upcomingResult, hoursResult] = await Promise.all([
        supabase.rpc('get_court_board', { request_time: boardNow }),
        supabase.rpc('get_active_waitlist', { request_time: boardNow }),
        supabase.rpc('get_upcoming_blocks', { request_time: boardNow }),
        supabase.from('operating_hours').select('*').order('day_of_week'),
      ]);

      if (courtsResult.error) {
        console.error('Failed to fetch board after assign-court:', courtsResult.error);
      } else {
        const upcomingBlocks = (upcomingResult.data || []).map((b: any) => ({
          id: b.block_id,
          courtId: b.court_id,
          courtNumber: b.court_number,
          blockType: b.block_type,
          title: b.title,
          startsAt: b.starts_at,
          endsAt: b.ends_at,
        }));

        board = {
          serverNow: boardNow,
          courts: courtsResult.data || [],
          waitlist: waitlistResult.data || [],
          operatingHours: hoursResult.data || [],
          upcomingBlocks,
        };
      }
    } catch (boardError) {
      console.error('Failed to fetch board after assign-court:', boardError);
    }

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

/**
 * Add CORS headers to a response
 */
function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
