// ============================================
// DEVELOPMENT FLAG - Controlled via Supabase project secret SKIP_GEOFENCE_CHECK
// Set the secret to 'true' to skip validation (dev/testing).
// Remove the secret or set it to 'false' for production — no code deploy needed.
// ============================================
const SKIP_GEOFENCE_CHECK = (globalThis as any)?.Deno?.env?.get?.('SKIP_GEOFENCE_CHECK') === 'true'

// Haversine formula to calculate distance between two coordinates
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371e3 // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c // Distance in meters
}

export interface GeofenceResult {
  isValid: boolean
  distance: number
  threshold: number
  message: string
}

export async function validateGeofence(
  supabase: any,
  userLat: number,
  userLon: number
): Promise<GeofenceResult> {
  // Skip geofence check if disabled for development/testing
  if (SKIP_GEOFENCE_CHECK) {
    console.log('⚠️ SKIP_GEOFENCE_CHECK is enabled - bypassing location validation')
    return {
      isValid: true,
      distance: 0,
      threshold: 0,
      message: 'Location check skipped (development mode)',
    }
  }

  // Get club coordinates from settings
  const { data: latSetting } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'club_latitude')
    .single()

  const { data: lonSetting } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'club_longitude')
    .single()

  const { data: radiusSetting } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'geofence_radius_meters')
    .single()

  if (!latSetting || !lonSetting) {
    return {
      isValid: false,
      distance: 0,
      threshold: 0,
      message: 'Club location not configured',
    }
  }

  const clubLat = parseFloat(latSetting.value)
  const clubLon = parseFloat(lonSetting.value)
  const threshold = radiusSetting ? parseFloat(radiusSetting.value) : 80

  const distance = calculateDistance(userLat, userLon, clubLat, clubLon)
  const isValid = distance <= threshold

  return {
    isValid,
    distance: Math.round(distance),
    threshold,
    message: isValid
      ? 'Location verified'
      : `You must be at the club to register (${Math.round(distance)}m away, limit is ${threshold}m)`,
  }
}

// ============================================
// Location Token Validation
// ============================================

export interface TokenValidationResult {
  isValid: boolean
  tokenId?: string
  message: string
}

/**
 * Validate and consume a location token
 * Token is marked as used upon successful validation
 */
export async function validateLocationToken(
  supabase: any,
  token: string,
  memberId: string,
  deviceId: string
): Promise<TokenValidationResult> {
  if (!token || token.length !== 32) {
    return {
      isValid: false,
      message: 'Invalid token format',
    }
  }

  // Find the token
  const { data: tokenRow, error: findError } = await supabase
    .from('location_tokens')
    .select('id, expires_at, used_at')
    .eq('token', token.toUpperCase())
    .single()

  if (findError || !tokenRow) {
    return {
      isValid: false,
      message: 'Token not found',
    }
  }

  // Check if already used
  if (tokenRow.used_at) {
    return {
      isValid: false,
      tokenId: tokenRow.id,
      message: 'Token has already been used',
    }
  }

  // Check if expired
  const now = new Date()
  const expiresAt = new Date(tokenRow.expires_at)
  if (now > expiresAt) {
    return {
      isValid: false,
      tokenId: tokenRow.id,
      message: 'Token has expired',
    }
  }

  // Mark token as used
  const { error: updateError } = await supabase
    .from('location_tokens')
    .update({
      used_at: now.toISOString(),
      used_by_member_id: memberId,
      used_by_device_id: deviceId,
    })
    .eq('id', tokenRow.id)
    .is('used_at', null) // Ensure not already used (race condition protection)

  if (updateError) {
    return {
      isValid: false,
      tokenId: tokenRow.id,
      message: 'Failed to validate token',
    }
  }

  return {
    isValid: true,
    tokenId: tokenRow.id,
    message: 'Location verified via token',
  }
}
