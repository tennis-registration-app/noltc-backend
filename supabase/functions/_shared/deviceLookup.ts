/**
 * Device verification helper for Edge Functions
 *
 * Verifies a device is registered, throws if not found, and updates last_seen_at.
 * Used by assign-court and assign-from-waitlist (and any future function that
 * requires device verification before proceeding).
 */

/**
 * Verify a device is registered and update its last_seen_at timestamp.
 *
 * @param supabase - Supabase client with service role
 * @param deviceId - The device UUID to look up
 * @param serverNow - The request's consistent timestamp (used for last_seen_at)
 * @returns The device record
 * @throws Error('Device not registered') if device is not found
 */
export async function verifyDevice(
  supabase: any,
  deviceId: string,
  serverNow: string
): Promise<Record<string, any>> {
  const { data: device, error: deviceError } = await supabase
    .from('devices')
    .select('*')
    .eq('id', deviceId)
    .single()

  if (deviceError || !device) {
    throw new Error('Device not registered')
  }

  await supabase
    .from('devices')
    .update({ last_seen_at: serverNow })
    .eq('id', deviceId)

  return device
}
