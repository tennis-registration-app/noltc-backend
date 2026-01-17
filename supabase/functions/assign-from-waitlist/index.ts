import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { validateGeofence, validateLocationToken } from "../_shared/geofence.ts"
import { generateParticipantKey } from "../_shared/participantKey.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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
            action: 'waitlist_assign',
            entity_type: 'session',
            entity_id: '00000000-0000-0000-0000-000000000000',
            device_id: requestData.device_id,
            device_type: requestData.device_type,
            initiated_by: requestData.initiated_by || 'user',
            request_data: {
              waitlist_id: requestData.waitlist_id,
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
        // QR token-based validation (member ID will be resolved from waitlist_members later)
        // For now, use a placeholder - token validation just needs device_id
        const tokenResult = await validateLocationToken(
          supabase,
          requestData.location_token!,
          '00000000-0000-0000-0000-000000000000', // Member ID resolved after waitlist lookup
          requestData.device_id
        )

        geofenceStatus = tokenResult.isValid ? 'validated' : 'failed'

        if (tokenResult.isValid) {
          geoVerifiedMethod = 'qr'
        } else {
          // Log the failed token attempt
          await supabase.from('audit_log').insert({
            action: 'waitlist_assign',
            entity_type: 'session',
            entity_id: '00000000-0000-0000-0000-000000000000',
            device_id: requestData.device_id,
            device_type: requestData.device_type,
            initiated_by: requestData.initiated_by || 'user',
            request_data: {
              waitlist_id: requestData.waitlist_id,
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
        // End the overtime session
        console.log(`Ending overtime session ${activeSession.id} for waitlist takeover`)

        // Update the session's actual_end_at (required for unique constraint)
        const { error: endSessionError } = await supabase
          .from('sessions')
          .update({
            actual_end_at: serverNow,
            end_reason: 'overtime_takeover'
          })
          .eq('id', activeSession.id)
          .is('actual_end_at', null) // Only if not already ended

        if (endSessionError) {
          console.error('Failed to end overtime session:', endSessionError)
          throw new Error(`Failed to end overtime session: ${endSessionError.message}`)
        }

        // Also insert END event for audit trail (ignore errors if already exists)
        const { error: eventError } = await supabase
          .from('session_events')
          .insert({
            session_id: activeSession.id,
            event_type: 'END',
            event_data: {
              reason: 'overtime_takeover',
              ended_by: requestData.device_id,
              ended_at: serverNow
            },
            created_by: requestData.device_id
          })
        if (eventError) {
          console.warn('Event insert warning (may already exist):', eventError.message)
        }

        console.log(`✅ Successfully ended overtime session ${activeSession.id}`)
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

    const durationKey = waitlistEntry.group_type === 'singles'
      ? 'singles_duration_minutes'
      : 'doubles_duration_minutes'

    const { data: durationSetting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', durationKey)
      .single()

    const durationMinutes = durationSetting
      ? parseInt(durationSetting.value)
      : (waitlistEntry.group_type === 'singles' ? 60 : 90)

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
        console.log('[assign-from-waitlist] Re-registration detected, participant_key:', participantKey);
        console.log('[assign-from-waitlist] Inheriting end time from session:', previousSession.id, inheritedEndTime.toISOString());
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

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({
        court_id: requestData.court_id,
        session_type: waitlistEntry.group_type,
        duration_minutes: durationMinutes,
        started_at: startedAt.toISOString(),
        scheduled_end_at: scheduledEndAt.toISOString(),
        created_by_device_id: requestData.device_id,
        participant_key: participantKey,
      })
      .select()
      .single()

    if (sessionError || !session) {
      throw new Error(`Failed to create session: ${sessionError?.message}`)
    }

    sessionId = session.id

    // ===========================================
    // CREATE SESSION PARTICIPANTS
    // ===========================================

    const participantRecords = waitlistMembers.map(wm => ({
      session_id: session.id,
      member_id: wm.participant_type === 'member' ? wm.member_id : null,
      guest_name: wm.participant_type === 'guest' ? wm.guest_name : null,
      participant_type: wm.participant_type,
      account_id: wm.account_id,
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

    const guests = waitlistMembers.filter(wm => wm.participant_type === 'guest')
    const dayOfWeek = now.getDay()

    if (guests.length > 0) {
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
      const feeKey = isWeekend ? 'guest_fee_weekend_cents' : 'guest_fee_weekday_cents'

      const { data: feeSetting } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', feeKey)
        .single()

      const guestFeeCents = feeSetting ? parseInt(feeSetting.value) : (isWeekend ? 2000 : 1500)

      for (const guest of guests) {
        await supabase
          .from('transactions')
          .insert({
            account_id: guest.account_id,
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
      const memberParticipants = waitlistMembers.filter(wm => wm.participant_type === 'member')

      if (requestData.split_balls && memberParticipants.length > 1) {
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
        await supabase
          .from('transactions')
          .insert({
            account_id: waitlistMembers[0].account_id,
            transaction_type: 'ball_purchase',
            amount_cents: ballPriceCents,
            description: 'Tennis balls',
            session_id: session.id,
            created_by_device_id: requestData.device_id,
          })
      }
    }

    // ===========================================
    // UPDATE WAITLIST ENTRY
    // ===========================================

    const { error: waitlistUpdateError } = await supabase
      .from('waitlist')
      .update({
        status: 'assigned',
        assigned_at: now.toISOString(),
        assigned_session_id: session.id,
      })
      .eq('id', requestData.waitlist_id)

    if (waitlistUpdateError) {
      throw new Error(`Failed to update waitlist: ${waitlistUpdateError.message}`)
    }

    // ===========================================
    // REORDER REMAINING WAITLIST
    // ===========================================

    const { data: entriesToUpdate } = await supabase
      .from('waitlist')
      .select('id, position')
      .eq('status', 'waiting')
      .gt('position', assignedPosition)
      .order('position', { ascending: true })

    if (entriesToUpdate && entriesToUpdate.length > 0) {
      for (const entry of entriesToUpdate) {
        await supabase
          .from('waitlist')
          .update({ position: entry.position - 1 })
          .eq('id', entry.id)
      }
    }

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

    // Insert board change signal for real-time updates
    await supabase
      .from("board_change_signals")
      .insert({ change_type: "session" });

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
      positions_updated: entriesToUpdate?.length || 0,
      isInheritedEndTime: !!inheritedEndTime,
      inheritedFromScheduledEnd: inheritedEndTime?.toISOString() || null,
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
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  }
})
