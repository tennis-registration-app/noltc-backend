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
    const { data: waitlist, error } = await supabase
      .from('active_waitlist_view')
      .select('*')
      .order('position')

    if (error) {
      throw new Error(`Failed to fetch waitlist: ${error.message}`)
    }

    const formattedWaitlist = waitlist?.map(entry => ({
      id: entry.waitlist_id,
      position: entry.position,
      group_type: entry.group_type,
      joined_at: entry.joined_at,
      minutes_waiting: Math.round(entry.minutes_waiting),
      participants: entry.participant_names || [],
    }))

    return new Response(JSON.stringify({
      ok: true,
      timestamp: new Date().toISOString(),
      count: formattedWaitlist?.length || 0,
      waitlist: formattedWaitlist,
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
