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

    const { member_id } = await req.json()

    if (!member_id) {
      return new Response(
        JSON.stringify({ ok: false, error: 'member_id is required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Read from cache (fast lookup)
    const { data: cacheRow, error: cacheError } = await supabaseClient
      .from('frequent_partners_cache')
      .select('partners, computed_at')
      .eq('member_id', member_id)
      .single()

    if (cacheError && cacheError.code !== 'PGRST116') {
      // PGRST116 = row not found, which is OK
      throw cacheError
    }

    if (cacheRow) {
      // Cache hit - return cached partners
      return new Response(
        JSON.stringify({
          ok: true,
          partners: cacheRow.partners || [],
          cached_at: cacheRow.computed_at
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Cache miss - call live RPC and trigger background cache refresh
    console.log('[get-frequent-partners] Cache miss for member:', member_id)

    // Call live RPC function
    const { data: livePartners, error: rpcError } = await supabaseClient
      .rpc('get_frequent_partners', { p_member_id: member_id })

    if (rpcError) {
      console.error('[get-frequent-partners] RPC error:', rpcError)
      // Return empty on error rather than failing
      return new Response(
        JSON.stringify({ ok: true, partners: [], cached_at: null, source: 'error' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Transform RPC result to match cache format
    const partners = (livePartners || []).map((p: any) => ({
      member_id: p.member_id,
      display_name: p.display_name,
      member_number: p.member_number,
      play_count: p.play_count,
      is_recent: p.is_recent
    }))

    // Trigger background cache refresh (fire-and-forget)
    supabaseClient
      .rpc('refresh_single_member_cache', { p_member_id: member_id })
      .then(() => console.log('[get-frequent-partners] Cache refreshed for:', member_id))
      .catch((err: any) => console.error('[get-frequent-partners] Cache refresh failed:', err))

    return new Response(
      JSON.stringify({ ok: true, partners, cached_at: null, source: 'live' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
