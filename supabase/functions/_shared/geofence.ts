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
