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

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const url = new URL(req.url)
    const memberName = url.searchParams.get('member_name') || null
    const dateStart = url.searchParams.get('date_start') || null
    const dateEnd = url.searchParams.get('date_end') || null
    const courtNumber = url.searchParams.get('court_number')
      ? parseInt(url.searchParams.get('court_number')!)
      : null
    const limit = parseInt(url.searchParams.get('limit') || '100')

    // Call the RPC function - all filters applied at DB level before limit
    const { data: sessions, error } = await supabase.rpc('search_session_history', {
      p_member_name: memberName,
      p_date_start: dateStart,
      p_date_end: dateEnd,
      p_court_number: courtNumber,
      p_limit: limit
    })

    if (error) {
      console.error('[get-session-history] RPC error:', error)
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    // Transform RPC result to match existing response format
    const formattedSessions = (sessions || []).map((s: any) => ({
      id: s.id,
      date: s.started_at?.split('T')[0],
      started_at: s.started_at,
      ended_at: s.actual_end_at,
      session_type: s.session_type,
      duration_minutes: s.duration_minutes,
      end_reason: s.end_reason,
      court_number: s.court_number,
      court_name: null, // RPC doesn't return court name
      participants: (s.participants || []).map((p: any) => ({
        name: p.display_name,
        type: p.participant_type,
        member_number: p.member_number,
      })),
    }))

    return new Response(
      JSON.stringify({ ok: true, count: formattedSessions.length, sessions: formattedSessions }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('[get-session-history] Error:', error)
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
