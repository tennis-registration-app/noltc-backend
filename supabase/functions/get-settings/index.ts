import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  try {
    // Get system settings
    const { data: settings, error: settingsError } = await supabase
      .from('system_settings')
      .select('key, value')

    if (settingsError) {
      throw new Error(`Failed to fetch settings: ${settingsError.message}`)
    }

    // Get operating hours
    const { data: hours, error: hoursError } = await supabase
      .from('operating_hours')
      .select('*')
      .order('day_of_week')

    if (hoursError) {
      throw new Error(`Failed to fetch operating hours: ${hoursError.message}`)
    }

    // Get upcoming overrides (next 30 days)
    const today = new Date().toISOString().slice(0, 10)
    const thirtyDaysLater = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const { data: overrides, error: overridesError } = await supabase
      .from('operating_hours_overrides')
      .select('*')
      .gte('date', today)
      .lte('date', thirtyDaysLater)
      .order('date')

    if (overridesError) {
      throw new Error(`Failed to fetch overrides: ${overridesError.message}`)
    }

    // Format settings as object
    const settingsObj: Record<string, any> = {}
    settings?.forEach(s => {
      // Convert numeric values
      if (s.key.includes('cents') || s.key.includes('minutes') || s.key.includes('meters')) {
        settingsObj[s.key] = parseInt(s.value)
      } else if (s.key.includes('latitude') || s.key.includes('longitude')) {
        settingsObj[s.key] = parseFloat(s.value)
      } else {
        settingsObj[s.key] = s.value
      }
    })

    // Add formatted prices in dollars
    settingsObj.ball_price_dollars = (settingsObj.ball_price_cents / 100).toFixed(2)
    settingsObj.guest_fee_weekday_dollars = (settingsObj.guest_fee_weekday_cents / 100).toFixed(2)
    settingsObj.guest_fee_weekend_dollars = (settingsObj.guest_fee_weekend_cents / 100).toFixed(2)

    // Format operating hours
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const formattedHours = hours?.map(h => ({
      day_of_week: h.day_of_week,
      day_name: dayNames[h.day_of_week],
      opens_at: h.opens_at,
      closes_at: h.closes_at,
      is_closed: h.is_closed,
    }))

    return new Response(JSON.stringify({
      ok: true,
      settings: settingsObj,
      operating_hours: formattedHours,
      upcoming_overrides: overrides,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
