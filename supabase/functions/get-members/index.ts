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
    // Parse query params
    const url = new URL(req.url)
    const search = url.searchParams.get('search')
    const accountId = url.searchParams.get('account_id')
    const memberNumber = url.searchParams.get('member_number')

    let query = supabase
      .from('members')
      .select(`
        id,
        display_name,
        is_primary,
        status,
        account_id,
        plays_180d,
        last_played_at,
        accounts(member_number, account_name)
      `)
      .eq('status', 'active')
      // Sort by play frequency (most active first), then by name
      .order('plays_180d', { ascending: false })
      .order('last_played_at', { ascending: false, nullsFirst: false })
      .order('display_name')

    // Apply filters
    if (search) {
      query = query.ilike('display_name', `%${search}%`)
    }
    if (accountId) {
      query = query.eq('account_id', accountId)
    }
    if (memberNumber) {
      // Need to filter by account's member_number
      const { data: account } = await supabase
        .from('accounts')
        .select('id')
        .eq('member_number', memberNumber)
        .single()

      if (account) {
        query = query.eq('account_id', account.id)
      } else {
        // No matching account, return empty
        return new Response(JSON.stringify({
          ok: true,
          count: 0,
          members: [],
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }
    }

    const { data: members, error } = await query

    if (error) {
      throw new Error(`Failed to fetch members: ${error.message}`)
    }

    const formattedMembers = members?.map(m => ({
      id: m.id,
      display_name: m.display_name,
      is_primary: m.is_primary,
      account_id: m.account_id,
      member_number: m.accounts?.member_number,
      account_name: m.accounts?.account_name,
      plays_180d: m.plays_180d,
    }))

    return new Response(JSON.stringify({
      ok: true,
      count: formattedMembers?.length || 0,
      members: formattedMembers,
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
