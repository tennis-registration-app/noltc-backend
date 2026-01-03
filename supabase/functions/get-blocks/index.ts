import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface GetBlocksRequest {
  device_id: string
  device_type: string
  court_id?: string      // Optional: filter by court
  from_date?: string     // Optional: ISO date, defaults to serverNow
  to_date?: string       // Optional: ISO date, defaults to from_date + 90 days
}

interface BlockResponse {
  id: string
  courtId: string
  courtNumber: number
  blockType: string
  title: string
  startsAt: string
  endsAt: string
  isRecurring: boolean
  recurrenceRule: string | null
  createdAt: string
}

/**
 * Get Blocks (Admin Only)
 *
 * Returns blocks within a date range for the admin panel timeline/calendar views.
 * Unlike get-board which only returns currently active blocks, this returns
 * all blocks (past, current, future) within the specified range.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const serverNow = new Date().toISOString()

  try {
    const requestData = await req.json() as GetBlocksRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.device_id) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'device_id is required',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    if (!requestData.device_type) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'device_type is required',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // ===========================================
    // VERIFY DEVICE AND ADMIN ACCESS
    // ===========================================

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('id, device_type, is_active')
      .eq('id', requestData.device_id)
      .single()

    if (deviceError || !device) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'DEVICE_NOT_FOUND',
        message: 'Device not registered',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }

    // Check admin authorization
    if (requestData.device_type !== 'admin') {
      return new Response(JSON.stringify({
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Admin access required to view blocks',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403,
      })
    }

    // Update device last_seen_at
    await supabase
      .from('devices')
      .update({ last_seen_at: serverNow })
      .eq('id', requestData.device_id)

    // ===========================================
    // DATE RANGE HANDLING
    // ===========================================

    const now = new Date(serverNow)
    const DEFAULT_RANGE_DAYS = 90
    const MAX_RANGE_DAYS = 366

    let fromDate: Date
    let toDate: Date

    if (requestData.from_date && requestData.to_date) {
      // Both provided
      fromDate = new Date(requestData.from_date)
      toDate = new Date(requestData.to_date)
    } else if (requestData.from_date) {
      // Only from_date provided - default to_date = from_date + 90 days
      fromDate = new Date(requestData.from_date)
      toDate = new Date(fromDate)
      toDate.setDate(toDate.getDate() + DEFAULT_RANGE_DAYS)
    } else if (requestData.to_date) {
      // Only to_date provided - default from_date = serverNow
      fromDate = now
      toDate = new Date(requestData.to_date)
    } else {
      // Neither provided - from_date = serverNow, to_date = serverNow + 90 days
      fromDate = now
      toDate = new Date(now)
      toDate.setDate(toDate.getDate() + DEFAULT_RANGE_DAYS)
    }

    // Validate dates
    if (isNaN(fromDate.getTime())) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'from_date is not a valid date',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    if (isNaN(toDate.getTime())) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'to_date is not a valid date',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // Enforce max range
    const rangeDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)
    if (rangeDays > MAX_RANGE_DAYS) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    if (rangeDays < 0) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'to_date must be after from_date',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // ===========================================
    // QUERY BLOCKS
    // ===========================================

    let query = supabase
      .from('blocks')
      .select(`
        id,
        court_id,
        block_type,
        title,
        starts_at,
        ends_at,
        is_recurring,
        recurrence_rule,
        created_at,
        courts!inner (
          court_number
        )
      `)
      .is('cancelled_at', null)
      .lt('starts_at', toDate.toISOString())
      .gt('ends_at', fromDate.toISOString())
      .order('starts_at', { ascending: true })

    // Optional court filter
    if (requestData.court_id) {
      query = query.eq('court_id', requestData.court_id)
    }

    const { data: blocks, error: blocksError } = await query

    if (blocksError) {
      console.error('[get-blocks] Query error:', blocksError)
      return new Response(JSON.stringify({
        ok: false,
        code: 'QUERY_ERROR',
        message: 'Failed to fetch blocks',
        serverNow,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    // ===========================================
    // TRANSFORM RESPONSE
    // ===========================================

    const transformedBlocks: BlockResponse[] = (blocks || []).map((b: any) => ({
      id: b.id,
      courtId: b.court_id,
      courtNumber: b.courts?.court_number || 0,
      blockType: b.block_type,
      title: b.title,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      isRecurring: b.is_recurring,
      recurrenceRule: b.recurrence_rule,
      createdAt: b.created_at,
    }))

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      blocks: transformedBlocks,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error('[get-blocks] Unexpected error:', error)
    return new Response(JSON.stringify({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: error.message || 'An unexpected error occurred',
      serverNow,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
