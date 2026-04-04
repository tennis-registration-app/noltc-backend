/**
 * Geofence enforcement helper for Edge Functions
 *
 * Handles the full GPS / QR-token check flow for mobile devices:
 * - Non-mobile devices pass through immediately
 * - GPS path: calls validateGeofence(), writes denied audit log on failure, throws
 * - QR path: calls validateLocationToken(), writes denied audit log on failure, throws
 * - Mobile with neither: throws
 *
 * Returns geofenceStatus and geoVerifiedMethod for use in the caller's success audit log.
 */

import { validateGeofence, validateLocationToken } from './geofence.ts';

export interface GeofenceOptions {
  deviceType: string;
  deviceId: string;
  initiatedBy?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  locationToken?: string;
  memberId?: string;        // For QR token validation; defaults to zero UUID if not provided
  serverNow: string;
  auditAction: string;
  auditRequestData: Record<string, unknown>;  // Caller-specific fields merged into request_data
  ipAddress: string;
}

export interface GeofenceCheckResult {
  geofenceStatus: 'validated' | 'failed' | 'not_required';
  geoVerifiedMethod: 'gps' | 'qr' | null;
}

/**
 * Enforce geofence for mobile devices.
 *
 * Writes a denied audit log entry and throws on geofence failure.
 * Returns geofenceStatus and geoVerifiedMethod for inclusion in the success audit log.
 *
 * @param supabase - Supabase client with service role
 * @param options - Geofence check options
 * @returns geofenceStatus and geoVerifiedMethod
 */
export async function enforceGeofence(
  supabase: any,
  options: GeofenceOptions
): Promise<GeofenceCheckResult> {
  let geofenceStatus: 'validated' | 'failed' | 'not_required' = 'not_required';
  let geoVerifiedMethod: 'gps' | 'qr' | null = null;

  if (options.deviceType !== 'mobile') {
    return { geofenceStatus, geoVerifiedMethod };
  }

  const hasGps = options.latitude && options.longitude;
  const hasToken = options.locationToken;

  if (hasGps) {
    // GPS-based validation
    const geofenceResult = await validateGeofence(
      supabase,
      options.latitude!,
      options.longitude!
    );

    geofenceStatus = geofenceResult.isValid ? 'validated' : 'failed';

    if (geofenceResult.isValid) {
      geoVerifiedMethod = 'gps';
    } else {
      // Log the failed GPS attempt
      await supabase.from('audit_log').insert({
        action: options.auditAction,
        entity_type: 'session',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: options.deviceId,
        device_type: options.deviceType,
        initiated_by: options.initiatedBy || 'user',
        request_data: {
          latitude: options.latitude,
          longitude: options.longitude,
          accuracy: options.accuracy,
          distance: geofenceResult.distance,
          threshold: geofenceResult.threshold,
          geo_verified_method: 'gps',
          ...options.auditRequestData,
        },
        outcome: 'denied',
        error_message: geofenceResult.message,
        geofence_status: 'failed',
        ip_address: options.ipAddress,
      });

      throw new Error(geofenceResult.message);
    }
  } else if (hasToken) {
    // QR token-based validation
    const memberId = options.memberId || '00000000-0000-0000-0000-000000000000';

    const tokenResult = await validateLocationToken(
      supabase,
      options.locationToken!,
      memberId,
      options.deviceId
    );

    geofenceStatus = tokenResult.isValid ? 'validated' : 'failed';

    if (tokenResult.isValid) {
      geoVerifiedMethod = 'qr';
    } else {
      // Log the failed token attempt
      await supabase.from('audit_log').insert({
        action: options.auditAction,
        entity_type: 'session',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: options.deviceId,
        device_type: options.deviceType,
        initiated_by: options.initiatedBy || 'user',
        request_data: {
          location_token: options.locationToken,
          token_id: tokenResult.tokenId,
          geo_verified_method: 'qr',
          ...options.auditRequestData,
        },
        outcome: 'denied',
        error_message: tokenResult.message,
        geofence_status: 'failed',
        ip_address: options.ipAddress,
      });

      throw new Error(tokenResult.message);
    }
  } else {
    // Neither GPS nor token provided
    throw new Error('Location required for mobile registration');
  }

  return { geofenceStatus, geoVerifiedMethod };
}
