/**
 * Operating hours enforcement for Edge Functions.
 *
 * Shared by assign-court and join-waitlist — both require the club to be
 * open before allowing registrations. Throws with a user-facing message
 * if outside hours; returns void if within hours.
 *
 * @param supabase - Supabase client with service role
 * @param serverNow - ISO timestamp captured at request start (used for time checks)
 */
export async function checkOperatingHours(
  supabase: any,
  serverNow: string
): Promise<void> {
  const now = new Date(serverNow)
  const centralTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const dayOfWeek = centralTime.getDay()
  const hours = centralTime.getHours().toString().padStart(2, '0')
  const minutes = centralTime.getMinutes().toString().padStart(2, '0')
  const seconds = centralTime.getSeconds().toString().padStart(2, '0')
  const currentTime = `${hours}:${minutes}:${seconds}` // HH:MM:SS
  const today = centralTime.toISOString().slice(0, 10)  // YYYY-MM-DD

  // Check for a date-specific override first
  const { data: override } = await supabase
    .from('operating_hours_overrides')
    .select('*')
    .eq('date', today)
    .single()

  let opensAt = ''
  let closesAt = ''

  if (override) {
    if (override.is_closed) {
      throw new Error('The club is closed today')
    }
    opensAt = override.opens_at
    closesAt = override.closes_at
  } else {
    // Fall back to regular day-of-week hours
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
}
