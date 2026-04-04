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
