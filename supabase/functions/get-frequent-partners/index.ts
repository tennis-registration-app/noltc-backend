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
    const { member_number } = await req.json()

    if (!member_number) {
      return new Response(
        JSON.stringify({ ok: false, error: 'member_number is required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Look up account by member_number
    const { data: accountData, error: accountError } = await supabase
      .from('accounts')
      .select('id')
      .eq('member_number', member_number)
      .single()

    if (accountError || !accountData) {
      return new Response(
        JSON.stringify({ ok: true, partners: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get primary member for this account
    const { data: member, error: memberError } = await supabase
      .from('members')
      .select('id')
      .eq('account_id', accountData.id)
      .eq('is_primary', true)
      .single()

    if (memberError || !member) {
      return new Response(
        JSON.stringify({ ok: true, partners: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Call the SQL function to get frequent partners
    const { data, error } = await supabase.rpc('get_frequent_partners', {
      p_member_id: member.id
    })

    if (error) {
      throw new Error(`Failed to get frequent partners: ${error.message}`)
    }

    return new Response(
      JSON.stringify({
        ok: true,
        partners: data || [],
        count: data?.length || 0
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
