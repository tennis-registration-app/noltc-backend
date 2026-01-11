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

    const { start, end } = await req.json().catch(() => ({}))

    // Default to last 7 days if not provided
    const endDate = end || new Date().toISOString().split('T')[0]
    const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    // Fetch summary
    const { data: summaryData, error: summaryError } = await supabaseClient.rpc(
      'get_analytics_summary',
      { start_date: startDate, end_date: endDate }
    )
    if (summaryError) throw summaryError

    // Fetch heatmap using date range
    const { data: heatmapData, error: heatmapError } = await supabaseClient.rpc(
      'get_usage_heatmap_range',
      { start_date: startDate, end_date: endDate }
    )
    if (heatmapError) throw heatmapError

    // Fetch waitlist stats
    const { data: waitlistData, error: waitlistError } = await supabaseClient.rpc(
      'get_waitlist_stats',
      { start_date: startDate, end_date: endDate }
    )
    if (waitlistError) throw waitlistError

    // Fetch waitlist heatmap
    const { data: waitlistHeatmapData, error: waitlistHeatmapError } = await supabaseClient.rpc(
      'get_waitlist_heatmap',
      { start_date: startDate, end_date: endDate }
    )
    if (waitlistHeatmapError) throw waitlistHeatmapError

    // Transform summary (it returns an array with one row)
    const s = summaryData?.[0] || {}

    const response = {
      ok: true,
      serverNow: new Date().toISOString(),
      range: { start: startDate, end: endDate },
      summary: {
        sessions: s.sessions_count || 0,
        courtHoursUsed: parseFloat(s.court_hours_used) || 0,
        courtHoursScheduled: parseFloat(s.court_hours_scheduled) || 0,
        utilizationPct: parseFloat(s.utilization_pct) || 0,
        avgSessionsPerDay: parseFloat(s.avg_sessions_per_day) || 0,
        avgCourtHoursPerDay: parseFloat(s.avg_court_hours_per_day) || 0,
        previous: {
          courtHoursUsed: parseFloat(s.prev_court_hours_used) || 0,
          utilizationPct: parseFloat(s.prev_utilization_pct) || 0
        }
      },
      heatmap: (heatmapData || []).map((h: { day_of_week: number; hour: number; session_count: number }) => ({
        dow: h.day_of_week,
        hour: h.hour,
        count: h.session_count
      })),
      waitlist: (waitlistData || []).map((w: { id: string; group_type: string; joined_at: string; assigned_at: string; minutes_waited: number; player_names: string[] }) => ({
        id: w.id,
        groupType: w.group_type,
        joinedAt: w.joined_at,
        assignedAt: w.assigned_at,
        minutesWaited: w.minutes_waited,
        playerNames: w.player_names
      })),
      waitlistHeatmap: (waitlistHeatmapData || []).map((w: { day_of_week: number; hour: number; group_count: number; avg_wait_minutes: number }) => ({
        dow: w.day_of_week,
        hour: w.hour,
        count: w.group_count,
        avgWait: w.avg_wait_minutes
      }))
    }

    return new Response(
      JSON.stringify(response),
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
