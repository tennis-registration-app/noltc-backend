import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { days = 90 } = await req.json().catch(() => ({}))
    const clampedDays = Math.max(7, Math.min(365, Number(days) || 90))

    const { data, error } = await supabaseClient.rpc('get_usage_heatmap', { days_back: clampedDays })

    if (error) throw error

    return new Response(
      JSON.stringify({
        ok: true,
        heatmap: data || [],
        daysAnalyzed: clampedDays,
        serverNow: new Date().toISOString()
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error.message,
        serverNow: new Date().toISOString()
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
