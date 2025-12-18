import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

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
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  let requestData: AssignCourtRequest | null = null
  let auditEntityId = '00000000-0000-0000-0000-000000000000'

  try {
    requestData = await req.json() as AssignCourtRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.court_id) {
      throw new Error('court_id is required')
    }
    if (!requestData.session_type || !['singles', 'doubles'].includes(requestData.session_type)) {
      throw new Error('session_type must be "singles" or "doubles"')
    }
    if (!requestData.participants || requestData.participants.length === 0) {
      throw new Error('At least one participant is required')
    }
    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // Validate participant count for session type
    const minPlayers = requestData.session_type === 'singles' ? 1 : 2
    const maxPlayers = requestData.session_type === 'singles' ? 2 : 4
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
    const dayOfWeek = now.getDay() // 0 = Sunday
    const currentTime = now.toTimeString().slice(0, 8) // HH:MM:SS format
    const today = now.toISOString().slice(0, 10) // YYYY-MM-DD

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
      const { data: hours, error: hoursError } = await supabase
        .from('operating_hours')
        .select('*')
        .eq('day_of_week', dayOfWeek)
        .single()

      if (hoursError || !hours) {
        throw new Error('Could not determine operating hours')
      }

      if (hours.is_closed) {
        throw new Error('The club is closed today')
      }
      opensAt = hours.opens_at
      closesAt = hours.closes_at
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
    // CHECK COURT AVAILABILITY (with lock)
    // ===========================================

    // Check for active session
    const { data: activeSession } = await supabase
      .from('sessions')
      .select('id')
      .eq('court_id', requestData.court_id)
      .is('actual_end_at', null)
      .single()

    if (activeSession) {
      throw new Error('Court is currently occupied')
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
    const scheduledEndAt = new Date(startedAt.getTime() + durationMinutes * 60 * 1000)

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({
        court_id: requestData.court_id,
        session_type: requestData.session_type,
        duration_minutes: durationMinutes,
        started_at: startedAt.toISOString(),
        scheduled_end_at: scheduledEndAt.toISOString(),
        created_by_device_id: requestData.device_id,
      })
      .select()
      .single()

    if (sessionError || !session) {
      throw new Error(`Failed to create session: ${sessionError?.message}`)
    }

    auditEntityId = session.id

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
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    // Fetch the complete session with participants for response
    const { data: completeSession } = await supabase
      .from('active_sessions_view')
      .select('*')
      .eq('session_id', session.id)
      .single()

    return new Response(JSON.stringify({
      ok: true,
      session: {
        id: session.id,
        court_id: session.court_id,
        court_number: court.court_number,
        court_name: court.name,
        session_type: session.session_type,
        duration_minutes: session.duration_minutes,
        started_at: session.started_at,
        scheduled_end_at: session.scheduled_end_at,
        participants: completeSession?.participant_names || [],
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

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

    return new Response(JSON.stringify({
      ok: false,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
