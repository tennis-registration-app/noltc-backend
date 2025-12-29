import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface PurchaseBallsRequest {
  device_id: string
  device_type: string
  session_id: string
  account_id: string
  split_balls?: boolean
  split_account_ids?: string[]  // If splitting, which accounts to charge
  idempotency_key?: string  // Client-provided key to prevent duplicate charges
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Consistent timestamp for the entire request
  const serverNow = new Date().toISOString()

  let requestData: PurchaseBallsRequest | null = null

  try {
    requestData = await req.json() as PurchaseBallsRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }
    if (!requestData.session_id) {
      throw new Error('session_id is required')
    }
    if (!requestData.account_id) {
      throw new Error('account_id is required')
    }

    // ===========================================
    // VERIFY DEVICE
    // ===========================================

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      throw new Error('Device not registered')
    }

    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    // ===========================================
    // VERIFY SESSION EXISTS
    // ===========================================

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('*, courts(court_number, name)')
      .eq('id', requestData.session_id)
      .single()

    if (sessionError || !session) {
      throw new Error('Session not found')
    }

    // ===========================================
    // IDEMPOTENCY CHECK
    // ===========================================

    if (requestData.idempotency_key) {
      // Check if a transaction with this idempotency key already exists
      const { data: existingTx, error: existingError } = await supabase
        .from('transactions')
        .select('id, account_id, amount_cents, description')
        .eq('idempotency_key', requestData.idempotency_key)
        .maybeSingle()

      if (existingTx) {
        // Return cached result - don't charge again
        console.log(`[purchase-balls] Idempotent hit: ${requestData.idempotency_key}`)

        await supabase.from('audit_log').insert({
          action: 'ball_purchase_idempotent',
          entity_type: 'transaction',
          entity_id: existingTx.id,
          device_id: requestData.device_id,
          device_type: device.device_type,
          initiated_by: 'user',
          request_data: {
            idempotency_key: requestData.idempotency_key,
            cached_transaction_id: existingTx.id,
          },
          outcome: 'success',
          ip_address: req.headers.get('x-forwarded-for') || 'unknown',
          created_at: serverNow,
        })

        return new Response(JSON.stringify({
          ok: true,
          serverNow,
          idempotent: true,
          transactions: [{
            id: existingTx.id,
            account_id: existingTx.account_id,
            amount_cents: existingTx.amount_cents,
            amount_dollars: (existingTx.amount_cents / 100).toFixed(2),
            description: existingTx.description,
          }],
          total_cents: existingTx.amount_cents,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }
    }

    // ===========================================
    // GET BALL PRICE
    // ===========================================

    const { data: ballPriceSetting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'ball_price_cents')
      .single()

    const ballPriceCents = ballPriceSetting ? parseInt(ballPriceSetting.value) : 500

    // ===========================================
    // CREATE TRANSACTION(S)
    // ===========================================

    const transactions = []

    if (requestData.split_balls && requestData.split_account_ids && requestData.split_account_ids.length > 1) {
      // Split the cost among multiple accounts
      const splitAmount = Math.ceil(ballPriceCents / requestData.split_account_ids.length)

      for (const accountId of requestData.split_account_ids) {
        const { data: account } = await supabase
          .from('accounts')
          .select('account_name')
          .eq('id', accountId)
          .single()

        // For split transactions, append account suffix to idempotency key
        const splitIdempotencyKey = requestData.idempotency_key
          ? `${requestData.idempotency_key}-${accountId}`
          : null

        const { data: tx, error: txError } = await supabase
          .from('transactions')
          .insert({
            account_id: accountId,
            session_id: requestData.session_id,
            transaction_type: 'ball_purchase',
            amount_cents: splitAmount,
            description: `Ball purchase (split) - ${session.courts?.name || 'Court'}`,
            created_by_device_id: requestData.device_id,
            idempotency_key: splitIdempotencyKey,
          })
          .select()
          .single()

        if (txError) {
          throw new Error(`Failed to create transaction: ${txError.message}`)
        }
        transactions.push(tx)
      }
    } else {
      // Single account pays full price
      const { data: tx, error: txError } = await supabase
        .from('transactions')
        .insert({
          account_id: requestData.account_id,
          session_id: requestData.session_id,
          transaction_type: 'ball_purchase',
          amount_cents: ballPriceCents,
          description: `Ball purchase - ${session.courts?.name || 'Court'}`,
          created_by_device_id: requestData.device_id,
          idempotency_key: requestData.idempotency_key || null,
        })
        .select()
        .single()

      if (txError) {
        throw new Error(`Failed to create transaction: ${txError.message}`)
      }
      transactions.push(tx)
    }

    // ===========================================
    // AUDIT LOG
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'ball_purchase',
        entity_type: 'transaction',
        entity_id: transactions[0].id,
        device_id: requestData.device_id,
        device_type: device.device_type,
        initiated_by: 'user',
        request_data: {
          session_id: requestData.session_id,
          account_id: requestData.account_id,
          split: requestData.split_balls,
          amount_cents: ballPriceCents,
          idempotency_key: requestData.idempotency_key || null,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        created_at: serverNow,
      })

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      transactions: transactions.map(tx => ({
        id: tx.id,
        account_id: tx.account_id,
        amount_cents: tx.amount_cents,
        amount_dollars: (tx.amount_cents / 100).toFixed(2),
        description: tx.description,
      })),
      total_cents: transactions.reduce((sum, tx) => sum + tx.amount_cents, 0),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Log failure
    await supabase
      .from('audit_log')
      .insert({
        action: 'ball_purchase',
        entity_type: 'transaction',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: requestData?.device_id || null,
        device_type: requestData?.device_type || null,
        initiated_by: 'user',
        request_data: {
          ...requestData,
          idempotency_key: requestData?.idempotency_key || null,
        },
        outcome: 'failure',
        error_message: error.message,
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
        created_at: serverNow,
      })

    return new Response(JSON.stringify({
      ok: false,
      serverNow,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  }
})
