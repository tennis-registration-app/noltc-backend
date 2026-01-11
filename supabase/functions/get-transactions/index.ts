import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Convert UTC timestamp to Central Time for display
function formatCentralTime(utcTimestamp: string): { date: string, time: string } {
  const utc = new Date(utcTimestamp);
  const formatted = utc.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  // formatted: "01/10/2026, 20:09"
  const [datePart, timePart] = formatted.split(', ');
  const [month, day, year] = datePart.split('/');
  return {
    date: `${year}-${month}-${day}`,  // "2026-01-10"
    time: timePart                      // "20:09"
  };
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
    const transactionType = url.searchParams.get('type')
    const memberNumber = url.searchParams.get('member_number')
    const limit = parseInt(url.searchParams.get('limit') || '100')

    let query = supabase
      .from('transactions')
      .select(`
        id,
        transaction_type,
        amount_cents,
        description,
        created_at,
        session_id,
        accounts(member_number, account_name)
      `)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (dateStart) {
      query = query.gte('created_at', dateStart + 'T00:00:00Z')
    }
    if (dateEnd) {
      query = query.lte('created_at', dateEnd + 'T23:59:59Z')
    }
    if (transactionType) {
      query = query.eq('transaction_type', transactionType)
    }
    if (memberNumber) {
      const { data: account } = await supabase
        .from('accounts')
        .select('id')
        .eq('member_number', memberNumber)
        .single()
      if (account) {
        query = query.eq('account_id', account.id)
      }
    }

    const { data: transactions, error } = await query

    if (error) {
      throw new Error(`Failed to fetch transactions: ${error.message}`)
    }

    // Calculate summary
    const summary = {
      total_count: transactions?.length || 0,
      guest_fees: {
        count: transactions?.filter(t => t.transaction_type === 'guest_fee').length || 0,
        total_cents: transactions?.filter(t => t.transaction_type === 'guest_fee')
          .reduce((sum, t) => sum + t.amount_cents, 0) || 0,
      },
      ball_purchases: {
        count: transactions?.filter(t => t.transaction_type === 'ball_purchase').length || 0,
        total_cents: transactions?.filter(t => t.transaction_type === 'ball_purchase')
          .reduce((sum, t) => sum + t.amount_cents, 0) || 0,
      },
      reversals: {
        count: transactions?.filter(t => t.transaction_type === 'reversal').length || 0,
        total_cents: transactions?.filter(t => t.transaction_type === 'reversal')
          .reduce((sum, t) => sum + t.amount_cents, 0) || 0,
      },
    }

    // Add dollar amounts to summary
    summary.guest_fees.total_dollars = (summary.guest_fees.total_cents / 100).toFixed(2)
    summary.ball_purchases.total_dollars = (summary.ball_purchases.total_cents / 100).toFixed(2)
    summary.reversals.total_dollars = (summary.reversals.total_cents / 100).toFixed(2)

    const formattedTransactions = transactions?.map(t => {
      const centralTime = formatCentralTime(t.created_at);
      return {
        id: t.id,
        date: centralTime.date,
        time: centralTime.time,
        type: t.transaction_type,
        amount_cents: t.amount_cents,
        amount_dollars: (t.amount_cents / 100).toFixed(2),
        description: t.description,
        member_number: t.accounts?.member_number,
        account_name: t.accounts?.account_name,
        session_id: t.session_id,
      };
    })

    return new Response(JSON.stringify({
      ok: true,
      summary,
      transactions: formattedTransactions,
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
