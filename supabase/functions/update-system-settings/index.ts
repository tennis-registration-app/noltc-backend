import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface UpdateSettingsRequest {
  settings?: Record<string, string>  // key-value pairs for system_settings
  operating_hours?: {
    day_of_week: number
    opens_at: string
    closes_at: string
    is_closed?: boolean
  }[]
  operating_hours_override?: {
    date: string
    opens_at?: string
    closes_at?: string
    is_closed: boolean
    reason?: string
  }
  delete_override?: string  // date to delete override for
  device_id: string
  device_type: string
  initiated_by?: 'user' | 'ai_assistant'
}

const VALID_SETTINGS_KEYS = [
  'ball_price_cents',
  'guest_fee_weekday_cents',
  'guest_fee_weekend_cents',
  'singles_duration_minutes',
  'doubles_duration_minutes',
]

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  let requestData: UpdateSettingsRequest | null = null

  try {
    requestData = await req.json() as UpdateSettingsRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // Must have at least one thing to update
    if (!requestData.settings && !requestData.operating_hours && !requestData.operating_hours_override && !requestData.delete_override) {
      throw new Error('At least one of settings, operating_hours, operating_hours_override, or delete_override is required')
    }

    // ===========================================
    // VERIFY DEVICE EXISTS AND IS ADMIN
    // ===========================================

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      throw new Error('Device not registered')
    }

    if (device.device_type !== 'admin') {
      throw new Error('Only admin devices can update system settings')
    }

    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    const results: Record<string, any> = {}

    // ===========================================
    // UPDATE SYSTEM SETTINGS
    // ===========================================

    if (requestData.settings) {
      const updatedSettings: Record<string, string> = {}

      for (const [key, value] of Object.entries(requestData.settings)) {
        if (!VALID_SETTINGS_KEYS.includes(key)) {
          throw new Error(`Invalid settings key: ${key}`)
        }

        // Validate numeric values
        const numValue = parseInt(value)
        if (isNaN(numValue) || numValue < 0) {
          throw new Error(`Invalid value for ${key}: must be a non-negative number`)
        }

        const { error } = await supabase
          .from('system_settings')
          .update({
            value: value,
            updated_by_device_id: requestData.device_id,
          })
          .eq('key', key)

        if (error) {
          throw new Error(`Failed to update ${key}: ${error.message}`)
        }

        updatedSettings[key] = value
      }

      results.settings = updatedSettings

      // Audit log for settings update
      await supabase
        .from('audit_log')
        .insert({
          action: 'settings_update',
          entity_type: 'system_settings',
          entity_id: '00000000-0000-0000-0000-000000000000',
          device_id: requestData.device_id,
          device_type: requestData.device_type,
          initiated_by: requestData.initiated_by || 'user',
          request_data: { updated_settings: updatedSettings },
          outcome: 'success',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })
    }

    // ===========================================
    // UPDATE OPERATING HOURS
    // ===========================================

    if (requestData.operating_hours) {
      const updatedHours: any[] = []

      for (const hours of requestData.operating_hours) {
        if (hours.day_of_week < 0 || hours.day_of_week > 6) {
          throw new Error('day_of_week must be 0-6')
        }

        // Validate time format (HH:MM or HH:MM:SS)
        const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/
        if (!hours.is_closed) {
          if (!timeRegex.test(hours.opens_at)) {
            throw new Error(`Invalid opens_at time format: ${hours.opens_at}`)
          }
          if (!timeRegex.test(hours.closes_at)) {
            throw new Error(`Invalid closes_at time format: ${hours.closes_at}`)
          }
          if (hours.opens_at >= hours.closes_at) {
            throw new Error('closes_at must be after opens_at')
          }
        }

        const { error } = await supabase
          .from('operating_hours')
          .update({
            opens_at: hours.opens_at,
            closes_at: hours.closes_at,
            is_closed: hours.is_closed || false,
          })
          .eq('day_of_week', hours.day_of_week)

        if (error) {
          throw new Error(`Failed to update hours for day ${hours.day_of_week}: ${error.message}`)
        }

        updatedHours.push(hours)
      }

      results.operating_hours = updatedHours

      // Audit log for hours update
      await supabase
        .from('audit_log')
        .insert({
          action: 'operating_hours_update',
          entity_type: 'operating_hours',
          entity_id: '00000000-0000-0000-0000-000000000000',
          device_id: requestData.device_id,
          device_type: requestData.device_type,
          initiated_by: requestData.initiated_by || 'user',
          request_data: { updated_hours: updatedHours },
          outcome: 'success',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })
    }

    // ===========================================
    // CREATE/UPDATE OPERATING HOURS OVERRIDE
    // ===========================================

    if (requestData.operating_hours_override) {
      const override = requestData.operating_hours_override

      // Validate date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/
      if (!dateRegex.test(override.date)) {
        throw new Error('Invalid date format. Use YYYY-MM-DD')
      }

      if (!override.is_closed) {
        if (!override.opens_at || !override.closes_at) {
          throw new Error('opens_at and closes_at required when is_closed is false')
        }
        const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/
        if (!timeRegex.test(override.opens_at)) {
          throw new Error(`Invalid opens_at time format: ${override.opens_at}`)
        }
        if (!timeRegex.test(override.closes_at)) {
          throw new Error(`Invalid closes_at time format: ${override.closes_at}`)
        }
      }

      // Upsert the override
      const { data: existingOverride } = await supabase
        .from('operating_hours_overrides')
        .select('id')
        .eq('date', override.date)
        .single()

      if (existingOverride) {
        // Update existing
        const { error } = await supabase
          .from('operating_hours_overrides')
          .update({
            opens_at: override.is_closed ? null : override.opens_at,
            closes_at: override.is_closed ? null : override.closes_at,
            is_closed: override.is_closed,
            reason: override.reason || null,
          })
          .eq('date', override.date)

        if (error) {
          throw new Error(`Failed to update override: ${error.message}`)
        }
      } else {
        // Insert new
        const { error } = await supabase
          .from('operating_hours_overrides')
          .insert({
            date: override.date,
            opens_at: override.is_closed ? null : override.opens_at,
            closes_at: override.is_closed ? null : override.closes_at,
            is_closed: override.is_closed,
            reason: override.reason || null,
            created_by_device_id: requestData.device_id,
          })

        if (error) {
          throw new Error(`Failed to create override: ${error.message}`)
        }
      }

      results.operating_hours_override = override

      // Audit log
      await supabase
        .from('audit_log')
        .insert({
          action: 'operating_hours_override_set',
          entity_type: 'operating_hours_overrides',
          entity_id: '00000000-0000-0000-0000-000000000000',
          device_id: requestData.device_id,
          device_type: requestData.device_type,
          initiated_by: requestData.initiated_by || 'user',
          request_data: override,
          outcome: 'success',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })
    }

    // ===========================================
    // DELETE OPERATING HOURS OVERRIDE
    // ===========================================

    if (requestData.delete_override) {
      const { data: existingOverride } = await supabase
        .from('operating_hours_overrides')
        .select('*')
        .eq('date', requestData.delete_override)
        .single()

      if (!existingOverride) {
        throw new Error(`No override found for date: ${requestData.delete_override}`)
      }

      const { error } = await supabase
        .from('operating_hours_overrides')
        .delete()
        .eq('date', requestData.delete_override)

      if (error) {
        throw new Error(`Failed to delete override: ${error.message}`)
      }

      results.deleted_override = requestData.delete_override

      // Audit log
      await supabase
        .from('audit_log')
        .insert({
          action: 'operating_hours_override_delete',
          entity_type: 'operating_hours_overrides',
          entity_id: '00000000-0000-0000-0000-000000000000',
          device_id: requestData.device_id,
          device_type: requestData.device_type,
          initiated_by: requestData.initiated_by || 'user',
          request_data: { date: requestData.delete_override, previous_override: existingOverride },
          outcome: 'success',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        })
    }

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      updated: results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Audit log - failure
    await supabase
      .from('audit_log')
      .insert({
        action: 'settings_update',
        entity_type: 'system_settings',
        entity_id: '00000000-0000-0000-0000-000000000000',
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
