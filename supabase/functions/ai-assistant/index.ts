import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface AiAssistantRequest {
  prompt: string
  device_id: string
  device_type: string
}

// Define tools the AI can use
const tools = [
  {
    name: "create_block",
    description: "Block a court for a lesson, clinic, maintenance, or wet conditions. Use this when the user wants to block or reserve a court for non-play purposes.",
    input_schema: {
      type: "object",
      properties: {
        court_number: {
          type: "integer",
          description: "The court number (1-12)"
        },
        block_type: {
          type: "string",
          enum: ["lesson", "clinic", "maintenance", "wet", "other"],
          description: "The type of block"
        },
        title: {
          type: "string",
          description: "A descriptive title for the block"
        },
        starts_at: {
          type: "string",
          description: "Start time in ISO format (e.g., 2024-12-19T09:00:00Z)"
        },
        ends_at: {
          type: "string",
          description: "End time in ISO format (e.g., 2024-12-19T11:00:00Z)"
        }
      },
      required: ["court_number", "block_type", "title", "starts_at", "ends_at"]
    }
  },
  {
    name: "cancel_block",
    description: "Cancel an existing court block. Use this when the user wants to remove or cancel a block.",
    input_schema: {
      type: "object",
      properties: {
        block_id: {
          type: "string",
          description: "The UUID of the block to cancel"
        },
        court_number: {
          type: "integer",
          description: "The court number - used to find the block if block_id not provided"
        },
        title: {
          type: "string",
          description: "The title of the block - used to find the block if block_id not provided"
        }
      },
      required: []
    }
  },
  {
    name: "get_court_status",
    description: "Get the current status of all courts or a specific court. Shows active sessions and blocks.",
    input_schema: {
      type: "object",
      properties: {
        court_number: {
          type: "integer",
          description: "Optional: specific court number (1-12). If omitted, returns all courts."
        }
      },
      required: []
    }
  },
  {
    name: "get_session_history",
    description: "Query past sessions/games. Can filter by date, court, or member.",
    input_schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date to query (YYYY-MM-DD format)"
        },
        court_number: {
          type: "integer",
          description: "Filter by court number"
        },
        member_name: {
          type: "string",
          description: "Filter by member name (partial match)"
        },
        limit: {
          type: "integer",
          description: "Maximum number of results (default 20)"
        }
      },
      required: []
    }
  },
  {
    name: "get_transactions",
    description: "Query guest fees and ball purchases. Can filter by date or member.",
    input_schema: {
      type: "object",
      properties: {
        date_start: {
          type: "string",
          description: "Start date (YYYY-MM-DD)"
        },
        date_end: {
          type: "string",
          description: "End date (YYYY-MM-DD)"
        },
        member_number: {
          type: "string",
          description: "Filter by member account number"
        },
        transaction_type: {
          type: "string",
          enum: ["guest_fee", "ball_purchase", "reversal"],
          description: "Filter by transaction type"
        },
        limit: {
          type: "integer",
          description: "Maximum number of results (default 50)"
        }
      },
      required: []
    }
  },
  {
    name: "get_blocks",
    description: "Query court blocks. Can filter by date, court, or type.",
    input_schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date to query (YYYY-MM-DD)"
        },
        court_number: {
          type: "integer",
          description: "Filter by court number"
        },
        block_type: {
          type: "string",
          enum: ["lesson", "clinic", "maintenance", "wet", "other"],
          description: "Filter by block type"
        },
        include_cancelled: {
          type: "boolean",
          description: "Include cancelled blocks (default false)"
        }
      },
      required: []
    }
  },
  {
    name: "update_settings",
    description: "Update system settings like ball price or guest fees.",
    input_schema: {
      type: "object",
      properties: {
        ball_price: {
          type: "number",
          description: "Ball price in dollars (e.g., 5.50)"
        },
        guest_fee_weekday: {
          type: "number",
          description: "Weekday guest fee in dollars"
        },
        guest_fee_weekend: {
          type: "number",
          description: "Weekend guest fee in dollars"
        }
      },
      required: []
    }
  }
]

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  let requestData: AiAssistantRequest | null = null

  try {
    requestData = await req.json() as AiAssistantRequest

    // ===========================================
    // VALIDATION
    // ===========================================

    if (!requestData.prompt || requestData.prompt.trim() === '') {
      throw new Error('prompt is required')
    }
    if (!requestData.device_id) {
      throw new Error('device_id is required')
    }
    if (!anthropicApiKey) {
      throw new Error('Anthropic API key not configured')
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
      throw new Error('Only admin devices can use the AI assistant')
    }

    await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', requestData.device_id)

    // ===========================================
    // CALL ANTHROPIC API
    // ===========================================

    const systemPrompt = `You are an AI assistant for the New Orleans Lawn Tennis Club (NOLTC) court management system. You help club administrators manage courts, blocks, and view analytics.

Current date/time: ${new Date().toISOString()}

You have access to tools to:
- Create and cancel court blocks (lessons, clinics, maintenance, wet courts)
- View current court status
- Query session history (who played on which courts)
- Query transactions (guest fees, ball purchases)
- Update system settings (prices)

When users ask about courts, they refer to them by number (1-12).
When creating blocks, always confirm the details before executing.
Be concise but helpful in your responses.`

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        tools: tools,
        messages: [
          { role: 'user', content: requestData.prompt }
        ]
      }),
    })

    if (!anthropicResponse.ok) {
      const errorText = await anthropicResponse.text()
      throw new Error(`Anthropic API error: ${errorText}`)
    }

    const aiResult = await anthropicResponse.json()

    // ===========================================
    // PROCESS TOOL CALLS
    // ===========================================

    const toolResults: any[] = []
    let finalResponse = ''

    for (const content of aiResult.content) {
      if (content.type === 'text') {
        finalResponse += content.text
      } else if (content.type === 'tool_use') {
        const toolResult = await executeToolCall(
          supabase,
          content.name,
          content.input,
          requestData.device_id,
          requestData.device_type
        )
        toolResults.push({
          tool: content.name,
          input: content.input,
          result: toolResult,
        })
      }
    }

    // If there were tool calls, make a follow-up request to get natural language response
    if (toolResults.length > 0) {
      const followUpMessages = [
        { role: 'user', content: requestData.prompt },
        { role: 'assistant', content: aiResult.content },
        {
          role: 'user',
          content: toolResults.map(tr => ({
            type: 'tool_result',
            tool_use_id: aiResult.content.find((c: any) => c.type === 'tool_use' && c.name === tr.tool)?.id,
            content: JSON.stringify(tr.result)
          }))
        }
      ]

      const followUpResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: systemPrompt,
          tools: tools,
          messages: followUpMessages
        }),
      })

      if (followUpResponse.ok) {
        const followUpResult = await followUpResponse.json()
        for (const content of followUpResult.content) {
          if (content.type === 'text') {
            finalResponse = content.text
          }
        }
      }
    }

    // ===========================================
    // AUDIT LOG
    // ===========================================

    await supabase
      .from('audit_log')
      .insert({
        action: 'ai_assistant_query',
        entity_type: 'ai_assistant',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: 'ai_assistant',
        request_data: {
          prompt: requestData.prompt,
          tools_called: toolResults.map(tr => tr.tool),
        },
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    // ===========================================
    // RETURN RESPONSE
    // ===========================================

    return new Response(JSON.stringify({
      ok: true,
      response: finalResponse,
      tool_calls: toolResults,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    await supabase
      .from('audit_log')
      .insert({
        action: 'ai_assistant_query',
        entity_type: 'ai_assistant',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: requestData?.device_id || null,
        device_type: requestData?.device_type || null,
        initiated_by: 'ai_assistant',
        request_data: { prompt: requestData?.prompt },
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


// ===========================================
// TOOL EXECUTION
// ===========================================

async function executeToolCall(
  supabase: any,
  toolName: string,
  input: any,
  deviceId: string,
  deviceType: string
): Promise<any> {

  switch (toolName) {
    case 'create_block': {
      // Get court ID from court number
      const { data: court } = await supabase
        .from('courts')
        .select('id')
        .eq('court_number', input.court_number)
        .single()

      if (!court) {
        return { error: `Court ${input.court_number} not found` }
      }

      const { data: block, error } = await supabase
        .from('blocks')
        .insert({
          court_id: court.id,
          block_type: input.block_type,
          title: input.title,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
          created_by_device_id: deviceId,
        })
        .select()
        .single()

      if (error) {
        return { error: error.message }
      }

      // Audit log
      await supabase.from('audit_log').insert({
        action: 'block_create',
        entity_type: 'block',
        entity_id: block.id,
        device_id: deviceId,
        device_type: deviceType,
        initiated_by: 'ai_assistant',
        request_data: input,
        outcome: 'success',
      })

      return {
        success: true,
        block_id: block.id,
        message: `Created ${input.block_type} block "${input.title}" on Court ${input.court_number}`
      }
    }

    case 'cancel_block': {
      let blockToCancel

      if (input.block_id) {
        const { data } = await supabase
          .from('blocks')
          .select('*, courts(court_number)')
          .eq('id', input.block_id)
          .is('cancelled_at', null)
          .single()
        blockToCancel = data
      } else if (input.court_number && input.title) {
        const { data: court } = await supabase
          .from('courts')
          .select('id')
          .eq('court_number', input.court_number)
          .single()

        if (court) {
          const { data } = await supabase
            .from('blocks')
            .select('*, courts(court_number)')
            .eq('court_id', court.id)
            .ilike('title', `%${input.title}%`)
            .is('cancelled_at', null)
            .single()
          blockToCancel = data
        }
      }

      if (!blockToCancel) {
        return { error: 'Block not found' }
      }

      const { error } = await supabase
        .from('blocks')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('id', blockToCancel.id)

      if (error) {
        return { error: error.message }
      }

      await supabase.from('audit_log').insert({
        action: 'block_cancel',
        entity_type: 'block',
        entity_id: blockToCancel.id,
        device_id: deviceId,
        device_type: deviceType,
        initiated_by: 'ai_assistant',
        request_data: input,
        outcome: 'success',
      })

      return {
        success: true,
        message: `Cancelled block "${blockToCancel.title}" on Court ${blockToCancel.courts?.court_number}`
      }
    }

    case 'get_court_status': {
      let query = supabase.from('court_availability_view').select('*')

      if (input.court_number) {
        query = query.eq('court_number', input.court_number)
      }

      query = query.order('court_number')

      const { data, error } = await query

      if (error) {
        return { error: error.message }
      }

      return { courts: data }
    }

    case 'get_session_history': {
      let query = supabase
        .from('sessions')
        .select(`
          id,
          session_type,
          started_at,
          actual_end_at,
          duration_minutes,
          courts(court_number, name),
          session_participants(
            participant_type,
            guest_name,
            members(display_name)
          )
        `)
        .not('actual_end_at', 'is', null)
        .order('started_at', { ascending: false })
        .limit(input.limit || 20)

      if (input.date) {
        query = query
          .gte('started_at', input.date + 'T00:00:00Z')
          .lte('started_at', input.date + 'T23:59:59Z')
      }

      if (input.court_number) {
        const { data: court } = await supabase
          .from('courts')
          .select('id')
          .eq('court_number', input.court_number)
          .single()
        if (court) {
          query = query.eq('court_id', court.id)
        }
      }

      const { data, error } = await query

      if (error) {
        return { error: error.message }
      }

      // Format results
      const sessions = data?.map((s: any) => ({
        date: s.started_at.split('T')[0],
        time: s.started_at.split('T')[1].slice(0, 5),
        court: s.courts?.court_number,
        type: s.session_type,
        duration: s.duration_minutes,
        players: s.session_participants?.map((p: any) =>
          p.participant_type === 'member' ? p.members?.display_name : p.guest_name
        )
      }))

      return { sessions }
    }

    case 'get_transactions': {
      let query = supabase
        .from('transactions')
        .select(`
          id,
          transaction_type,
          amount_cents,
          description,
          created_at,
          accounts(member_number, account_name)
        `)
        .order('created_at', { ascending: false })
        .limit(input.limit || 50)

      if (input.date_start) {
        query = query.gte('created_at', input.date_start + 'T00:00:00Z')
      }
      if (input.date_end) {
        query = query.lte('created_at', input.date_end + 'T23:59:59Z')
      }
      if (input.transaction_type) {
        query = query.eq('transaction_type', input.transaction_type)
      }
      if (input.member_number) {
        const { data: account } = await supabase
          .from('accounts')
          .select('id')
          .eq('member_number', input.member_number)
          .single()
        if (account) {
          query = query.eq('account_id', account.id)
        }
      }

      const { data, error } = await query

      if (error) {
        return { error: error.message }
      }

      const transactions = data?.map((t: any) => ({
        date: t.created_at.split('T')[0],
        type: t.transaction_type,
        amount: (t.amount_cents / 100).toFixed(2),
        description: t.description,
        member: t.accounts?.member_number,
        account_name: t.accounts?.account_name,
      }))

      return { transactions }
    }

    case 'get_blocks': {
      let query = supabase
        .from('blocks')
        .select(`
          id,
          block_type,
          title,
          starts_at,
          ends_at,
          cancelled_at,
          courts(court_number)
        `)
        .order('starts_at', { ascending: false })

      if (!input.include_cancelled) {
        query = query.is('cancelled_at', null)
      }

      if (input.date) {
        query = query
          .gte('starts_at', input.date + 'T00:00:00Z')
          .lte('starts_at', input.date + 'T23:59:59Z')
      }

      if (input.court_number) {
        const { data: court } = await supabase
          .from('courts')
          .select('id')
          .eq('court_number', input.court_number)
          .single()
        if (court) {
          query = query.eq('court_id', court.id)
        }
      }

      if (input.block_type) {
        query = query.eq('block_type', input.block_type)
      }

      const { data, error } = await query

      if (error) {
        return { error: error.message }
      }

      const blocks = data?.map((b: any) => ({
        id: b.id,
        court: b.courts?.court_number,
        type: b.block_type,
        title: b.title,
        starts: b.starts_at,
        ends: b.ends_at,
        cancelled: b.cancelled_at ? true : false,
      }))

      return { blocks }
    }

    case 'update_settings': {
      const updates: Record<string, string> = {}

      if (input.ball_price !== undefined) {
        updates.ball_price_cents = String(Math.round(input.ball_price * 100))
      }
      if (input.guest_fee_weekday !== undefined) {
        updates.guest_fee_weekday_cents = String(Math.round(input.guest_fee_weekday * 100))
      }
      if (input.guest_fee_weekend !== undefined) {
        updates.guest_fee_weekend_cents = String(Math.round(input.guest_fee_weekend * 100))
      }

      if (Object.keys(updates).length === 0) {
        return { error: 'No settings to update' }
      }

      for (const [key, value] of Object.entries(updates)) {
        const { error } = await supabase
          .from('system_settings')
          .update({ value, updated_by_device_id: deviceId })
          .eq('key', key)

        if (error) {
          return { error: `Failed to update ${key}: ${error.message}` }
        }
      }

      await supabase.from('audit_log').insert({
        action: 'settings_update',
        entity_type: 'system_settings',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: deviceId,
        device_type: deviceType,
        initiated_by: 'ai_assistant',
        request_data: updates,
        outcome: 'success',
      })

      return { success: true, updated: updates }
    }

    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}
