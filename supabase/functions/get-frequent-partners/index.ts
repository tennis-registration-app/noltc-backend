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

    // Cache miss - new or inactive member, return empty
    return new Response(
      JSON.stringify({ ok: true, partners: [], cached_at: null }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
