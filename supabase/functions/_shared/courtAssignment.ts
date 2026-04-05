/**
 * Court assignment helpers for Edge Functions
 *
 * Shared logic for session duration lookup, guest fee processing,
 * and ball purchase processing — used by assign-court and assign-from-waitlist.
 */

// ---------------------------------------------------------------------------
// lookupDuration
// ---------------------------------------------------------------------------

/**
 * Read the configured session duration from system_settings.
 * Falls back to 60 min (singles) or 90 min (doubles) if the setting is missing.
 *
 * @param supabase - Supabase client with service role
 * @param sessionType - 'singles' or 'doubles'
 * @returns Duration in minutes
 */
export async function lookupDuration(
  supabase: any,
  sessionType: string
): Promise<number> {
  const durationKey = sessionType === 'singles'
    ? 'singles_duration_minutes'
    : 'doubles_duration_minutes'

  const { data: durationSetting } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', durationKey)
    .single()

  return durationSetting
    ? parseInt(durationSetting.value)
    : (sessionType === 'singles' ? 60 : 90)
}

// ---------------------------------------------------------------------------
// processGuestFees
// ---------------------------------------------------------------------------

export interface GuestParticipant {
  guest_name: string;
  account_id: string;
  charged_to_account_id?: string;  // Optional — assign-from-waitlist doesn't use this
}

/**
 * Insert guest fee transactions for all guest participants in a session.
 * Looks up weekend/weekday rate from system_settings.
 *
 * @param supabase - Supabase client with service role
 * @param guests - Normalized guest participant list (already filtered to guests only)
 * @param sessionId - The session these fees belong to
 * @param deviceId - Device that initiated the assignment
 * @param dayOfWeek - 0 (Sun) – 6 (Sat); passed by caller to preserve their timezone logic
 */
export async function processGuestFees(
  supabase: any,
  guests: GuestParticipant[],
  sessionId: string,
  deviceId: string,
  dayOfWeek: number
): Promise<void> {
  if (guests.length === 0) return

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
        session_id: sessionId,
        created_by_device_id: deviceId,
      })
  }
}

// ---------------------------------------------------------------------------
// processBallPurchase
// ---------------------------------------------------------------------------

export interface BallPurchaseParticipant {
  account_id: string;
  isMember: boolean;
}

export interface BallPurchaseOptions {
  addBalls: boolean;
  splitBalls?: boolean;
  participants: BallPurchaseParticipant[];
  sessionId: string;
  deviceId: string;
}

/**
 * Insert ball purchase transaction(s) if add_balls is true.
 * Splits the charge across member participants when split_balls is true and
 * there are multiple members; otherwise charges the first participant.
 *
 * @param supabase - Supabase client with service role
 * @param options - Ball purchase options
 */
export async function processBallPurchase(
  supabase: any,
  options: BallPurchaseOptions
): Promise<void> {
  if (!options.addBalls) return

  const { data: ballSetting } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'ball_price_cents')
    .single()

  const ballPriceCents = ballSetting ? parseInt(ballSetting.value) : 500
  const memberParticipants = options.participants.filter(p => p.isMember)

  if (options.splitBalls && memberParticipants.length > 1) {
    const splitAmount = Math.ceil(ballPriceCents / memberParticipants.length)

    for (const member of memberParticipants) {
      await supabase
        .from('transactions')
        .insert({
          account_id: member.account_id,
          transaction_type: 'ball_purchase',
          amount_cents: splitAmount,
          description: `Tennis balls (split ${memberParticipants.length} ways)`,
          session_id: options.sessionId,
          created_by_device_id: options.deviceId,
        })
    }
  } else {
    await supabase
      .from('transactions')
      .insert({
        account_id: options.participants[0].account_id,
        transaction_type: 'ball_purchase',
        amount_cents: ballPriceCents,
        description: 'Tennis balls',
        session_id: options.sessionId,
        created_by_device_id: options.deviceId,
      })
  }
}

// ---------------------------------------------------------------------------
// createSessionWithFees
// ---------------------------------------------------------------------------

export interface SessionParticipantInput {
  member_id: string | null
  guest_name: string | null
  participant_type: 'member' | 'guest'
  account_id: string
  charged_to_account_id?: string | null
}

export interface CreateSessionOptions {
  sessionId: string
  courtId: string
  sessionType: string
  durationMinutes: number
  startedAt: string        // ISO string
  scheduledEndAt: string   // ISO string, already computed (includes re-reg inheritance)
  deviceId: string
  participantKey: string | null
  registeredByMemberId: string | null
  participants: SessionParticipantInput[]
  dayOfWeek: number        // 0=Sun–6=Sat; used to resolve weekday/weekend guest fee rate
  addBalls: boolean
  splitBalls: boolean
  // Optional: assign-from-waitlist path only.
  // If provided, the RPC atomically marks the waitlist entry as assigned
  // and compacts the position sequence for remaining waiting entries.
  waitlistId?: string
  waitlistPosition?: number
}

export interface CreateSessionResult {
  session_id: string
  transaction_ids: string[]
}

/**
 * Create a session, its participants, and any associated transactions
 * (guest fees, ball purchase) in a single atomic DB transaction via RPC.
 *
 * Reads guest_fee_cents and ball_price_cents from system_settings, then
 * delegates all writes to the create_session_with_fees Postgres function.
 * If any step fails inside the RPC, the entire transaction is rolled back.
 */
export async function createSessionWithFees(
  supabase: any,
  options: CreateSessionOptions
): Promise<{ data: CreateSessionResult | null; error: any }> {
  // Resolve guest fee rate if any guests are present
  let guestFeeCents = 0
  const hasGuests = options.participants.some(p => p.participant_type === 'guest')

  if (hasGuests) {
    const isWeekend = options.dayOfWeek === 0 || options.dayOfWeek === 6
    const feeKey = isWeekend ? 'guest_fee_weekend_cents' : 'guest_fee_weekday_cents'
    const { data: feeSetting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', feeKey)
      .single()
    guestFeeCents = feeSetting ? parseInt(feeSetting.value) : (isWeekend ? 2000 : 1500)
  }

  // Resolve ball price if add_balls was requested
  let ballPriceCents = 0
  if (options.addBalls) {
    const { data: ballSetting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'ball_price_cents')
      .single()
    ballPriceCents = ballSetting ? parseInt(ballSetting.value) : 500
  }

  return supabase.rpc('create_session_with_fees', {
    p_session_id:              options.sessionId,
    p_court_id:                options.courtId,
    p_session_type:            options.sessionType,
    p_duration_minutes:        options.durationMinutes,
    p_started_at:              options.startedAt,
    p_scheduled_end_at:        options.scheduledEndAt,
    p_device_id:               options.deviceId,
    p_participant_key:         options.participantKey,
    p_registered_by_member_id: options.registeredByMemberId,
    p_participants:            options.participants,
    p_guest_fee_cents:         guestFeeCents,
    p_add_balls:               options.addBalls,
    p_ball_price_cents:        ballPriceCents,
    p_split_balls:             options.splitBalls,
    p_waitlist_id:             options.waitlistId ?? null,
    p_waitlist_position:       options.waitlistPosition ?? null,
  })
}
