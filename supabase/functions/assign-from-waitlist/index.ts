import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { enforceGeofence } from "../_shared/geofenceCheck.ts"
import { lookupDuration, createSessionWithFees } from "../_shared/courtAssignment.ts"
import { generateParticipantKey } from "../_shared/participantKey.ts"
import { endSession, signalBoardChange } from "../_shared/sessionLifecycle.ts"
import { verifyDevice } from "../_shared/deviceLookup.ts"
import { fetchBoardState } from "../_shared/boardFetch.ts"
import { corsHeaders } from "../_shared/cors.ts"

interface AssignFromWaitlistRequest {
  waitlist_id: string
  court_id: string
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

  let requestData: AssignFromWaitlistRequest | null = null
  let sessionId = '00000000-0000-0000-0000-000000000000'

  try {
    requestData = await req.json() as AssignFromWaitlistRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.waitlist_id) {
      throw new Error('waitlist_id is required')
    }
    if (!requestData.court_id) {
      throw new Error('court_id is required')
    }
    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // ===========================================
    // VERIFY DEVICE EXISTS
    // ===========================================

    const device = await verifyDevice(supabase, requestData.device_id, serverNow)

    // ===========================================
    // GEOFENCE VALIDATION (mobile only)
    // ===========================================

    const { geofenceStatus, geoVerifiedMethod } = await enforceGeofence(supabase, {
      deviceType: device.device_type,
      deviceId: requestData.device_id,
      initiatedBy: requestData.initiated_by,
      latitude: requestData.latitude,
      longitude: requestData.longitude,
      accuracy: requestData.accuracy,
      locationToken: requestData.location_token,
      serverNow,
      auditAction: 'waitlist_assign',
      auditRequestData: { waitlist_id: requestData.waitlist_id },
      ipAddress: req.headers.get('x-forwarded-for') || 'unknown',
    })

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
      throw new Error(`Cannot assign - status is "${waitlistEntry.status}"`)
    }

    const assignedPosition = waitlistEntry.position

    // ===========================================
    // GET WAITLIST PARTICIPANTS
    // ===========================================

    const { data: waitlistMembers, error: membersError } = await supabase
      .from('waitlist_members')
      .select(`
        id,
        member_id,
        guest_name,
        participant_type,
        account_id,
        members(display_name)
      `)
      .eq('waitlist_id', requestData.waitlist_id)

    if (membersError || !waitlistMembers || waitlistMembers.length === 0) {
      throw new Error('No participants found for waitlist entry')
    }

    // Generate participant key from waitlist members
    const participantKey = generateParticipantKey(waitlistMembers.map(wm => ({
      type: wm.participant_type,
      member_id: wm.member_id,
      guest_name: wm.guest_name,
    })));

    // ===========================================
    // VERIFY COURT EXISTS AND IS AVAILABLE
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
    if (SINGLES_ONLY_COURT_NUMBERS.includes(court.court_number) && waitlistEntry.group_type !== 'singles') {
      throw new Error('Court 8 is singles only')
    }

    // Check for active session
    const now = new Date()
    const { data: activeSession } = await supabase
      .from('sessions')
      .select('id, scheduled_end_at')
      .eq('court_id', requestData.court_id)
      .is('actual_end_at', null)
      .single()

    if (activeSession) {
      // Check if session is in overtime (scheduled_end_at is in the past)
      const scheduledEnd = new Date(activeSession.scheduled_end_at)
      const isOvertime = scheduledEnd < now

      if (isOvertime) {
        const endResult = await endSession(supabase, {
          sessionId: activeSession.id,
          serverNow,
          endReason: 'overtime_takeover',
          deviceId: requestData.device_id,
          eventData: {
            trigger: 'overtime_takeover',
            takeover_waitlist_id: requestData.waitlist_id,
          },
        })

        if (!endResult.success && !endResult.alreadyEnded) {
          console.error(`Failed to end displaced session ${activeSession.id}:`, endResult.error)
        }
      } else {
        throw new Error('Court is currently occupied')
      }
    }

    // Check for active block
    const { data: activeBlock } = await supabase
      .from('blocks')
      .select('id, title')
      .eq('court_id', requestData.court_id)
      .is('cancelled_at', null)
      .lte('starts_at', now.toISOString())
      .gt('ends_at', now.toISOString())
      .single()

    if (activeBlock) {
      throw new Error(`Court is blocked: ${activeBlock.title}`)
    }

    // ===========================================
    // GET DURATION FROM SETTINGS
    // ===========================================

    const durationMinutes = await lookupDuration(supabase, waitlistEntry.group_type)

    // ===========================================
    // CHECK FOR RE-REGISTRATION (same group cleared early)
    // ===========================================

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
    // CREATE SESSION
    // ===========================================

    const startedAt = new Date()
    const newEndTime = new Date(startedAt.getTime() + durationMinutes * 60 * 1000)
    const scheduledEndAt = inheritedEndTime
      ? new Date(Math.min(newEndTime.getTime(), inheritedEndTime.getTime()))
      : newEndTime

    // Get registrant member_id (first member in waitlist)
    const registrantMemberId = waitlistMembers.find(wm => wm.participant_type === 'member')?.member_id || null

    // ===========================================
    // CREATE SESSION, PARTICIPANTS, AND TRANSACTIONS (ATOMIC RPC)
    // ===========================================

    const newSessionId = crypto.randomUUID()

    const { data: rpcResult, error: rpcError } = await createSessionWithFees(supabase, {
      sessionId: newSessionId,
      courtId: requestData.court_id,
      sessionType: waitlistEntry.group_type,
      durationMinutes,
      startedAt: startedAt.toISOString(),
      scheduledEndAt: scheduledEndAt.toISOString(),
      deviceId: requestData.device_id,
      participantKey,
      registeredByMemberId: registrantMemberId,
      participants: waitlistMembers.map(wm => ({
        member_id: wm.participant_type === 'member' ? (wm.member_id ?? null) : null,
        guest_name: wm.participant_type === 'guest' ? (wm.guest_name ?? null) : null,
        participant_type: wm.participant_type,
        account_id: wm.account_id,
        charged_to_account_id: null,
      })),
      dayOfWeek: now.getDay(),
      addBalls: requestData.add_balls || false,
      splitBalls: requestData.split_balls || false,
      waitlistId: requestData.waitlist_id,
      waitlistPosition: assignedPosition,
    })

    if (rpcError || !rpcResult) {
      throw new Error(`Failed to create session: ${rpcError?.message}`)
    }

    const session = {
      id: rpcResult.session_id as string,
      court_id: requestData.court_id,
      session_type: waitlistEntry.group_type,
      duration_minutes: durationMinutes,
      started_at: startedAt.toISOString(),
      scheduled_end_at: scheduledEndAt.toISOString(),
    }

    sessionId = session.id

    // ===========================================
    // GET PARTICIPANT NAMES FOR RESPONSE
    // ===========================================

    const participantNames = waitlistMembers.map(wm =>
      wm.participant_type === 'member' ? wm.members?.display_name : wm.guest_name
    )

    const participantDetails = waitlistMembers.map(wm => ({
      name: wm.members?.display_name || wm.guest_name || 'Unknown',
      accountId: wm.account_id || null,
      memberId: wm.member_id || null,
      isGuest: !wm.member_id
    }))

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'waitlist_assign',
        entity_type: 'session',
        entity_id: session.id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        account_id: waitlistMembers[0].account_id,
        request_data: {
          waitlist_id: requestData.waitlist_id,
          waitlist_position: assignedPosition,
          court_number: court.court_number,
          group_type: waitlistEntry.group_type,
          participant_count: waitlistMembers.length,
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

    // Signal board change for real-time updates (db insert + broadcast)
    await signalBoardChange(supabase, 'session');

    // Fetch updated board state so frontend can apply without a separate refetch
    const board = await fetchBoardState(supabase, 'assign-from-waitlist');

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
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
        participantDetails: participantDetails,
      },
      waitlist: {
        id: waitlistEntry.id,
        previous_position: assignedPosition,
        status: 'assigned',
      },
      positions_updated: 0,
      timeLimitReason: inheritedEndTime ? 'rereg' : null,
      isInheritedEndTime: !!inheritedEndTime,
      inheritedFromScheduledEnd: inheritedEndTime?.toISOString() || null,
      board,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Audit log - failure
    await supabase
      .from('audit_log')
      .insert({
        action: 'waitlist_assign',
        entity_type: 'session',
        entity_id: sessionId,
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
      serverNow,
      code: 'INTERNAL_ERROR',
      message: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  }
})
