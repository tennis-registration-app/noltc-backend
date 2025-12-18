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
    const url = new URL(req.url)
    const dateStart = url.searchParams.get('date_start')
    const dateEnd = url.searchParams.get('date_end')
    const courtNumber = url.searchParams.get('court_number')
    const memberName = url.searchParams.get('member_name')
    const limit = parseInt(url.searchParams.get('limit') || '50')

    let query = supabase
      .from('sessions')
      .select(`
        id,
        session_type,
        duration_minutes,
        started_at,
        scheduled_end_at,
        actual_end_at,
        end_reason,
        courts(court_number, name),
        session_participants(
          participant_type,
          guest_name,
          members(display_name),
          accounts(member_number)
        )
      `)
      .not('actual_end_at', 'is', null)
      .order('started_at', { ascending: false })
      .limit(limit)

    if (dateStart) {
      query = query.gte('started_at', dateStart + 'T00:00:00Z')
    }
    if (dateEnd) {
      query = query.lte('started_at', dateEnd + 'T23:59:59Z')
    }
    if (courtNumber) {
      const { data: court } = await supabase
        .from('courts')
        .select('id')
        .eq('court_number', parseInt(courtNumber))
        .single()
      if (court) {
        query = query.eq('court_id', court.id)
      }
    }

    const { data: sessions, error } = await query

    if (error) {
      throw new Error(`Failed to fetch sessions: ${error.message}`)
    }

    // Filter by member name if provided (post-query filter)
    let filteredSessions = sessions
    if (memberName) {
      const searchLower = memberName.toLowerCase()
      filteredSessions = sessions?.filter(s =>
        s.session_participants?.some((p: any) => {
          const name = p.participant_type === 'member'
            ? p.members?.display_name
            : p.guest_name
          return name?.toLowerCase().includes(searchLower)
        })
      )
    }

    const formattedSessions = filteredSessions?.map(s => ({
      id: s.id,
      date: s.started_at.split('T')[0],
      started_at: s.started_at,
      ended_at: s.actual_end_at,
      session_type: s.session_type,
      duration_minutes: s.duration_minutes,
      end_reason: s.end_reason,
      court_number: s.courts?.court_number,
      court_name: s.courts?.name,
      participants: s.session_participants?.map((p: any) => ({
        name: p.participant_type === 'member' ? p.members?.display_name : p.guest_name,
        type: p.participant_type,
        member_number: p.accounts?.member_number,
      })),
    }))

    return new Response(JSON.stringify({
      ok: true,
      count: formattedSessions?.length || 0,
      sessions: formattedSessions,
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
