import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ExportRequest {
  date_range_start: string  // ISO date: YYYY-MM-DD
  date_range_end: string    // ISO date: YYYY-MM-DD
  include_already_exported?: boolean  // Default false
  device_id: string
  device_type: string
  initiated_by?: 'user' | 'ai_assistant' | 'system'
}

// Format date as MM/DD/YYYY for Jonas
function formatDateForJonas(isoDate: string): string {
  const date = new Date(isoDate)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const year = date.getFullYear()
  return `${month}/${day}/${year}`
}

// Format amount as dollars with 2 decimal places
function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

// Map transaction type to Jonas item code
function getItemCode(transactionType: string): string {
  switch (transactionType) {
    case 'guest_fee':
      return 'GUEST_FEE'
    case 'ball_purchase':
      return 'BALLS_CAN'
    case 'reversal':
      return 'REVERSAL'
    default:
      return 'MISC'
  }
}

// Map transaction type to department
function getDepartment(transactionType: string): string {
  switch (transactionType) {
    case 'guest_fee':
      return 'TENNIS'
    case 'ball_purchase':
      return 'PROSHOP'
    default:
      return 'TENNIS'
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  let requestData: ExportRequest | null = null
  let exportId = '00000000-0000-0000-0000-000000000000'

  try {
    requestData = await req.json() as ExportRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.date_range_start) {
      throw new Error('date_range_start is required (YYYY-MM-DD)')
    }
    if (!requestData.date_range_end) {
      throw new Error('date_range_end is required (YYYY-MM-DD)')
    }
    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRegex.test(requestData.date_range_start)) {
      throw new Error('date_range_start must be YYYY-MM-DD format')
    }
    if (!dateRegex.test(requestData.date_range_end)) {
      throw new Error('date_range_end must be YYYY-MM-DD format')
    }

    const startDate = new Date(requestData.date_range_start)
    const endDate = new Date(requestData.date_range_end)

    if (endDate < startDate) {
      throw new Error('date_range_end must be after date_range_start')
    }

    // ===========================================
    // VERIFY DEVICE EXISTS AND IS ADMIN
    // ===========================================

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      throw new Error('Device not registered')
    }

    if (device.device_type !== 'admin') {
      throw new Error('Only admin devices can export transactions')
    }

    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    // ===========================================
    // CREATE EXPORT RECORD
    // ===========================================

    const { data: exportRecord, error: exportError } = await supabase
      .from('exports')
      .insert({
        export_type: 'manual',
        status: 'pending',
        date_range_start: requestData.date_range_start + 'T00:00:00Z',
        date_range_end: requestData.date_range_end + 'T23:59:59Z',
        created_by_device_id: requestData.device_id,
      })
      .select()
      .single()

    if (exportError || !exportRecord) {
      throw new Error(`Failed to create export record: ${exportError?.message}`)
    }

    exportId = exportRecord.id

    // ===========================================
    // QUERY TRANSACTIONS
    // ===========================================

    // Build query for transactions in date range
    let query = supabase
      .from('transactions')
      .select(`
        id,
        account_id,
        transaction_type,
        amount_cents,
        description,
        session_id,
        created_at,
        accounts(member_number, account_name)
      `)
      .gte('created_at', requestData.date_range_start + 'T00:00:00Z')
      .lte('created_at', requestData.date_range_end + 'T23:59:59Z')
      .order('created_at', { ascending: true })

    const { data: transactions, error: txError } = await query

    if (txError) {
      throw new Error(`Failed to query transactions: ${txError.message}`)
    }

    if (!transactions || transactions.length === 0) {
      // Update export as completed with 0 records
      await supabase
        .from('exports')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          record_count: 0,
        })
        .eq('id', exportId)

      return new Response(JSON.stringify({
        ok: true,
        export_id: exportId,
        record_count: 0,
        message: 'No transactions found in date range',
        csv: null,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ===========================================
    // FILTER ALREADY EXPORTED (if requested)
    // ===========================================

    let transactionsToExport = transactions

    if (!requestData.include_already_exported) {
      // Get IDs of already exported transactions
      const { data: alreadyExported } = await supabase
        .from('export_items')
        .select('transaction_id')
        .in('transaction_id', transactions.map(t => t.id))

      const exportedIds = new Set(alreadyExported?.map(e => e.transaction_id) || [])
      transactionsToExport = transactions.filter(t => !exportedIds.has(t.id))

      if (transactionsToExport.length === 0) {
        await supabase
          .from('exports')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            record_count: 0,
          })
          .eq('id', exportId)

        return new Response(JSON.stringify({
          ok: true,
          export_id: exportId,
          record_count: 0,
          message: 'All transactions in date range have already been exported',
          csv: null,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }
    }

    // ===========================================
    // GENERATE CSV
    // ===========================================

    // Header row
    const csvHeader = 'MemberNumber,TransactionDate,ItemCode,Quantity,UnitPrice,Department,Description,Reference'

    // Data rows
    const csvRows = transactionsToExport.map(t => {
      const memberNumber = t.accounts?.member_number || 'UNKNOWN'
      const transactionDate = formatDateForJonas(t.created_at)
      const itemCode = getItemCode(t.transaction_type)
      const quantity = '1'
      const unitPrice = formatAmount(Math.abs(t.amount_cents))
      const department = getDepartment(t.transaction_type)
      const description = `"${t.description.replace(/"/g, '""')}"`  // Escape quotes
      const reference = t.session_id ? `SESSION-${t.session_id.slice(0, 8)}` : `TX-${t.id.slice(0, 8)}`

      return `${memberNumber},${transactionDate},${itemCode},${quantity},${unitPrice},${department},${description},${reference}`
    })

    const csvContent = [csvHeader, ...csvRows].join('\n')

    // ===========================================
    // RECORD EXPORT ITEMS
    // ===========================================

    const exportItems = transactionsToExport.map(t => ({
      export_id: exportId,
      transaction_id: t.id,
    }))

    const { error: itemsError } = await supabase
      .from('export_items')
      .insert(exportItems)

    if (itemsError) {
      throw new Error(`Failed to record export items: ${itemsError.message}`)
    }

    // ===========================================
    // UPDATE EXPORT RECORD
    // ===========================================

    const { error: updateError } = await supabase
      .from('exports')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        record_count: transactionsToExport.length,
      })
      .eq('id', exportId)

    if (updateError) {
      throw new Error(`Failed to update export record: ${updateError.message}`)
    }

    // ===========================================
    // AUDIT LOG - SUCCESS
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'transactions_export',
        entity_type: 'export',
        entity_id: exportId,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: requestData.initiated_by || 'user',
        request_data: {
          date_range_start: requestData.date_range_start,
          date_range_end: requestData.date_range_end,
          record_count: transactionsToExport.length,
          include_already_exported: requestData.include_already_exported || false,
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // CALCULATE SUMMARY
    // ===========================================

    const summary = {
      total_transactions: transactionsToExport.length,
      guest_fees: transactionsToExport.filter(t => t.transaction_type === 'guest_fee').length,
      ball_purchases: transactionsToExport.filter(t => t.transaction_type === 'ball_purchase').length,
      reversals: transactionsToExport.filter(t => t.transaction_type === 'reversal').length,
      total_amount: formatAmount(transactionsToExport.reduce((sum, t) => sum + t.amount_cents, 0)),
    }

    // ===========================================
    // RETURN SUCCESS
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      export_id: exportId,
      record_count: transactionsToExport.length,
      summary: summary,
      csv: csvContent,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Update export as failed if we created one
    if (exportId !== '00000000-0000-0000-0000-000000000000') {
      await supabase
        .from('exports')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: error.message,
        })
        .eq('id', exportId)
    }

    // Audit log - failure
    await supabase
      .from('audit_log')
      .insert({
        action: 'transactions_export',
        entity_type: 'export',
        entity_id: exportId,
        device_id: requestData?.device_id || null,
        device_type: requestData?.device_type || null,
        initiated_by: requestData?.initiated_by || 'user',
        request_data: requestData,
        outcome: 'failure',
        error_message: error.message,
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    return new Response(JSON.stringify({
      ok: false,
      error: error.message,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
