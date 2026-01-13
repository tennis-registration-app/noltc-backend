import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { create, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts"

// Payload limits
const MAX_PROMPT_CHARS = 2000;
const MAX_CONTEXT_CHARS = 50000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface AiAssistantRequest {
  prompt: string
  device_id: string
  device_type: string
  mode?: 'read' | 'draft' | 'execute'  // Default: 'draft'
  actions_token?: string               // Required for execute mode
  confirm_destructive?: boolean        // Required for high-risk in execute mode
}

interface ToolRisk {
  level: 'read' | 'low' | 'high'
  description: string
}

interface ProposedToolCall {
  id: string
  tool: string
  args: Record<string, unknown>
  risk: 'read' | 'low' | 'high'
  description: string  // Server-generated from args
}

interface AiAssistantResponse {
  ok: boolean
  response?: string
  error?: string
  mode?: 'read' | 'draft' | 'execute'
  proposed_tool_calls?: ProposedToolCall[]
  actions_token?: string
  requires_confirmation?: boolean
  executed_actions?: {
    tool: string
    success: boolean
    result?: unknown
    error?: string
  }[]
}

// Tool risk classification
const TOOL_RISKS: Record<string, ToolRisk> = {
  get_court_status: { level: 'read', description: 'View court availability' },
  get_session_history: { level: 'read', description: 'Query past sessions' },
  get_transactions: { level: 'read', description: 'Query transactions' },
  get_blocks: { level: 'read', description: 'List scheduled blocks' },
  create_block: { level: 'low', description: 'Create court block' },
  cancel_block: { level: 'low', description: 'Cancel court block' },
  update_settings: { level: 'high', description: 'Update system settings' },
  // Future tools
  end_session: { level: 'high', description: 'End active session' },
  move_court: { level: 'low', description: 'Move players between courts' },
  clear_all_courts: { level: 'high', description: 'Clear all courts' },
  clear_waitlist: { level: 'high', description: 'Clear entire waitlist' },
};

// Tools allowed in read-only mode
const READ_ONLY_TOOLS = ['get_court_status', 'get_session_history', 'get_transactions', 'get_blocks'];

// Helper to check if any proposed tools are high-risk
function hasHighRiskTools(toolCalls: Array<{ name: string }>): boolean {
  return toolCalls.some(tc => TOOL_RISKS[tc.name]?.level === 'high');
}

// Helper to filter tools by mode
function getToolsForMode(allTools: Array<{ name: string }>, mode: string): Array<{ name: string }> {
  if (mode === 'read') {
    return allTools.filter(t => READ_ONLY_TOOLS.includes(t.name));
  }
  return allTools; // draft and execute get all tools
}

// JWT secret for signing action tokens (use service role key or dedicated secret)
const getJwtSecret = async (): Promise<CryptoKey> => {
  const secret = Deno.env.get('AI_ACTIONS_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const encoder = new TextEncoder();
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
};

// Generate description from tool call args (server-side, not from Claude)
function generateToolDescription(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'create_block':
      return `Create ${args.block_type || 'block'} on Court ${args.court_number} (${args.title || 'No title'})`;
    case 'cancel_block':
      return `Cancel block ${args.block_id ? `ID ${args.block_id}` : `on Court ${args.court_number}`}`;
    case 'update_settings':
      const changes = Object.entries(args).map(([k, v]) => `${k}: ${v}`).join(', ');
      return `Update settings: ${changes}`;
    case 'get_court_status':
      return args.court_number ? `Get status for Court ${args.court_number}` : 'Get all court statuses';
    case 'get_session_history':
      return `Query session history${args.limit ? ` (limit ${args.limit})` : ''}`;
    case 'get_transactions':
      return `Query ${args.type || 'all'} transactions`;
    case 'get_blocks':
      return `List blocks${args.start_date ? ` from ${args.start_date}` : ''}`;
    default:
      return `Execute ${toolName}`;
  }
}

// Validate tool args before signing into token
function validateToolArgs(toolName: string, args: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  switch (toolName) {
    case 'create_block':
      if (!args.court_number || typeof args.court_number !== 'number') {
        return { ok: false, error: 'create_block requires valid court_number' };
      }
      if (!args.block_type || typeof args.block_type !== 'string') {
        return { ok: false, error: 'create_block requires block_type' };
      }
      if (!args.starts_at || !args.ends_at) {
        return { ok: false, error: 'create_block requires starts_at and ends_at' };
      }
      break;
    case 'cancel_block':
      if (!args.block_id && !args.court_number) {
        return { ok: false, error: 'cancel_block requires block_id or court_number' };
      }
      break;
    case 'update_settings':
      const SETTINGS_ALLOWLIST: Record<string, { type: string; min: number; max: number }> = {
        ballPrice: { type: 'number', min: 0, max: 100 },
        weekdayGuestFee: { type: 'number', min: 0, max: 500 },
        weekendGuestFee: { type: 'number', min: 0, max: 500 }
      };
      for (const [key, value] of Object.entries(args)) {
        const rule = SETTINGS_ALLOWLIST[key];
        if (!rule) {
          return { ok: false, error: `Setting not allowed: ${key}` };
        }
        if (typeof value !== rule.type) {
          return { ok: false, error: `Invalid type for ${key}` };
        }
        if (typeof value === 'number' && (value < rule.min || value > rule.max)) {
          return { ok: false, error: `${key} out of bounds (${rule.min}-${rule.max})` };
        }
      }
      break;
  }
  return { ok: true };
}

// Create JWT token for proposed actions
async function createActionsToken(
  deviceId: string,
  proposedCalls: ProposedToolCall[]
): Promise<string> {
  const key = await getJwtSecret();
  const payload = {
    device_id: deviceId,
    proposed_calls: proposedCalls,
    jti: crypto.randomUUID(),  // Unique token ID
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,  // 5 minute expiry
  };
  return await create({ alg: 'HS256', typ: 'JWT' }, payload, key);
}

// Verify JWT token and extract proposed calls
async function verifyActionsToken(
  token: string,
  deviceId: string
): Promise<{ ok: true, proposedCalls: ProposedToolCall[] } | { ok: false, error: string }> {
  try {
    const key = await getJwtSecret();
    const payload = await verify(token, key);

    if (payload.device_id !== deviceId) {
      return { ok: false, error: 'Token device mismatch' };
    }

    return { ok: true, proposedCalls: payload.proposed_calls as ProposedToolCall[] };
  } catch (err) {
    if (err.message?.includes('expired')) {
      return { ok: false, error: 'Token expired. Please request new actions.' };
    }
    return { ok: false, error: 'Invalid token' };
  }
}

// Execute a tool by calling the existing Edge Function endpoint
async function executeToolViaEndpoint(
  toolName: string,
  args: Record<string, unknown>,
  supabaseUrl: string,
  serviceRoleKey: string,
  deviceId: string,
  supabase: any
): Promise<{ ok: boolean; data?: unknown; error?: string }> {

  // Map tool names to endpoints and transform args as needed
  const endpointMap: Record<string, { endpoint: string; transformArgs?: (args: Record<string, unknown>, supabase: any) => Promise<Record<string, unknown>> | Record<string, unknown> }> = {
    create_block: {
      endpoint: 'create-block',
      transformArgs: async (args, supabase) => {
        // Convert court_number to court_id
        let courtId = args.court_id;
        if (!courtId && args.court_number) {
          const { data: court } = await supabase
            .from('courts')
            .select('id')
            .eq('court_number', args.court_number)
            .single();
          if (!court) {
            throw new Error(`Court ${args.court_number} not found`);
          }
          courtId = court.id;
        }

        return {
          court_id: courtId,
          block_type: args.block_type,
          title: args.title,
          starts_at: args.starts_at,
          ends_at: args.ends_at,
          device_id: deviceId,
          device_type: 'admin',
          initiated_by: 'ai_assistant'
        };
      }
    },
    cancel_block: {
      endpoint: 'cancel-block',
      transformArgs: async (args, supabase) => {
        // Convert court_number to court_id if needed
        let courtId = args.court_id;
        if (!courtId && args.court_number) {
          const { data: court } = await supabase
            .from('courts')
            .select('id')
            .eq('court_number', args.court_number)
            .single();
          if (court) {
            courtId = court.id;
          }
        }
        return {
          ...args,
          court_id: courtId,
          device_id: deviceId
        };
      }
    },
    update_settings: {
      endpoint: 'update-system-settings',
      transformArgs: (args) => {
        // Validate settings allowlist and bounds
        const SETTINGS_ALLOWLIST: Record<string, { type: string; min: number; max: number }> = {
          ballPrice: { type: 'number', min: 0, max: 100 },
          weekdayGuestFee: { type: 'number', min: 0, max: 500 },
          weekendGuestFee: { type: 'number', min: 0, max: 500 }
        };

        const validated: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args)) {
          const rule = SETTINGS_ALLOWLIST[key];
          if (!rule) {
            throw new Error(`Setting not allowed: ${key}`);
          }
          if (typeof value !== rule.type) {
            throw new Error(`Invalid type for ${key}: expected ${rule.type}`);
          }
          if (typeof value === 'number' && (value < rule.min || value > rule.max)) {
            throw new Error(`${key} out of bounds (${rule.min}-${rule.max})`);
          }
          validated[key] = value;
        }
        return validated;
      }
    },
    get_court_status: { endpoint: 'get-board' },
    get_session_history: { endpoint: 'get-session-history' },
    get_transactions: { endpoint: 'get-transactions' },
    get_blocks: { endpoint: 'get-blocks' }
  };

  const mapping = endpointMap[toolName];
  if (!mapping) {
    return { ok: false, error: `Unknown tool: ${toolName}` };
  }

  const transformedArgs = mapping.transformArgs
    ? await mapping.transformArgs(args, supabase)
    : args;

  // Determine HTTP method - read tools use GET, others use POST
  const isReadTool = READ_ONLY_TOOLS.includes(toolName);

  let response: Response;

  if (isReadTool && toolName !== 'get_court_status') {
    // GET request with query params
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(transformedArgs)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }
    const url = `${supabaseUrl}/functions/v1/${mapping.endpoint}?${params.toString()}`;
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
        'x-device-type': 'admin',
        'x-internal-call': 'ai-assistant'
      }
    });
  } else {
    // POST request with body
    response = await fetch(`${supabaseUrl}/functions/v1/${mapping.endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
        'x-device-type': 'admin',
        'x-internal-call': 'ai-assistant'
      },
      body: JSON.stringify(transformedArgs)
    });
  }

  const result = await response.json();

  if (!response.ok || result.ok === false) {
    return {
      ok: false,
      error: result.error || result.message || `HTTP ${response.status}`
    };
  }

  return { ok: true, data: result };
}

// Rate limiting - check and record requests
async function checkRateLimit(
  supabase: any,
  deviceId: string
): Promise<{ ok: true } | { ok: false; error: string; retryAfter: number }> {
  const RATE_LIMIT = parseInt(Deno.env.get('AI_RATE_LIMIT') || '10');
  const RATE_WINDOW = parseInt(Deno.env.get('AI_RATE_WINDOW') || '60'); // seconds

  const windowStart = new Date(Date.now() - RATE_WINDOW * 1000).toISOString();

  // Count recent requests
  const { count, error: countError } = await supabase
    .from('ai_rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('device_id', deviceId)
    .gte('created_at', windowStart);

  if (countError) {
    console.error('Rate limit check error:', countError);
    // Fail open - allow request if we can't check
    return { ok: true };
  }

  if (count && count >= RATE_LIMIT) {
    return {
      ok: false,
      error: `Rate limited. Maximum ${RATE_LIMIT} requests per ${RATE_WINDOW} seconds.`,
      retryAfter: RATE_WINDOW
    };
  }

  // Record this request
  await supabase.from('ai_rate_limits').insert({ device_id: deviceId });

  // Cleanup old entries occasionally (1% of requests trigger cleanup)
  if (Math.random() < 0.01) {
    const cleanupCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    await supabase
      .from('ai_rate_limits')
      .delete()
      .lt('created_at', cleanupCutoff);
  }

  return { ok: true };
}

// Context shaping helper - call this before building the system prompt
function shapeContext(courts: any[], waitlist: any[], settings: any): string {
  // Include IDs that tools need to execute
  const courtSummary = courts.map(c => ({
    court_number: c.court_number,
    court_id: c.id,
    status: c.status || (c.current_session ? 'occupied' : 'available'),
    players: c.current_session?.participants?.map((p: any) => p.member_name || p.guest_name) || [],
    session_id: c.current_session?.id || null,
    is_overtime: c.is_overtime || false,
    block: c.active_block ? {
      id: c.active_block.id,
      type: c.active_block.block_type,
      title: c.active_block.title
    } : null
  }));

  const waitlistSummary = waitlist.slice(0, 20).map((w: any, idx: number) => ({
    position: idx + 1,
    waitlist_id: w.id,
    group_type: w.group_type,
    members: w.members?.map((m: any) => m.member_name || m.guest_name) || []
  }));

  const context = {
    current_time: new Date().toISOString(),
    courts: courtSummary,
    waitlist_count: waitlist.length,
    waitlist: waitlistSummary,
    settings: {
      ball_price: settings?.ballPrice,
      weekday_guest_fee: settings?.weekdayGuestFee,
      weekend_guest_fee: settings?.weekendGuestFee
    }
  };

  let contextStr = JSON.stringify(context, null, 2);

  // Truncate if too large
  if (contextStr.length > MAX_CONTEXT_CHARS) {
    // Remove waitlist details first
    context.waitlist = [];
    contextStr = JSON.stringify(context, null, 2);
  }

  return contextStr;
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
    // MODE HANDLING
    // ===========================================

    const mode = requestData.mode || 'draft';  // Default to draft mode
    const actionsToken = requestData.actions_token;
    const confirmDestructive = requestData.confirm_destructive || false;

    // Validate mode
    if (!['read', 'draft', 'execute'].includes(mode)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Invalid mode. Must be read, draft, or execute.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Execute mode requires actions_token
    if (mode === 'execute' && !actionsToken) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Execute mode requires actions_token from draft response.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Filter tools based on mode
    const filteredTools = getToolsForMode(tools, mode);

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

    // Check rate limit
    const rateLimitResult = await checkRateLimit(supabase, requestData.device_id);
    if (!rateLimitResult.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: rateLimitResult.error }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': String(rateLimitResult.retryAfter)
          }
        }
      );
    }

    // Validate prompt length
    if (requestData.prompt.length > MAX_PROMPT_CHARS) {
      return new Response(
        JSON.stringify({ ok: false, error: `Prompt too long. Maximum ${MAX_PROMPT_CHARS} characters.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ===========================================
    // FETCH CONTEXT AND CALL ANTHROPIC API
    // ===========================================

    // Fetch current context for the AI
    const serverNow = new Date().toISOString();

    const [boardResult, waitlistResult, settingsResult] = await Promise.all([
      supabase.rpc('get_court_board', { request_time: serverNow }),
      supabase.rpc('get_active_waitlist', { request_time: serverNow }),
      supabase.from('system_settings').select('*')
    ]);

    const courts = boardResult.data || [];
    const waitlist = waitlistResult.data || [];
    // Convert settings array to object
    const settingsArray = settingsResult.data || [];
    const settings: Record<string, any> = {};
    for (const s of settingsArray) {
      settings[s.key] = s.value;
    }

    const contextStr = shapeContext(courts, waitlist, settings);

    const systemPrompt = `You are an AI administrative assistant for the New Orleans Lawn Tennis Club (NOLTC) court management system. Current time: ${serverNow}

CURRENT SYSTEM STATE:
${contextStr}

YOUR CAPABILITIES:
- View court status, session history, transactions, and scheduled blocks (read operations)
- Create and cancel court blocks for maintenance, lessons, clinics, etc.
- Update system settings (ball price, guest fees)

IMPORTANT RULES:
1. When asked about courts, players, or waitlist, refer to the CURRENT SYSTEM STATE above.
2. For any action that modifies data, use the appropriate tool.
3. Use court_number (1-12) when users reference courts.
4. Use court_id from the context when tools require it.
5. Be concise and helpful. Confirm what you're about to do before proposing actions.
6. If you're unsure, ask clarifying questions.

The user is an administrator with full access to manage courts, blocks, and settings.`

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
        tools: filteredTools,
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

    // === DRAFT MODE: Propose actions without executing ===
    if (mode === 'draft') {
      const proposedToolCalls: ProposedToolCall[] = [];
      let textResponse = '';

      for (const block of aiResult.content) {
        if (block.type === 'tool_use') {
          // Validate args before signing into token
          const validation = validateToolArgs(block.name, block.input as Record<string, unknown>);
          if (!validation.ok) {
            return new Response(
              JSON.stringify({ ok: false, error: `Invalid tool args: ${validation.error}` }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }

          const risk = TOOL_RISKS[block.name]?.level || 'low';
          proposedToolCalls.push({
            id: block.id,
            tool: block.name,
            args: block.input as Record<string, unknown>,
            risk: risk,
            description: generateToolDescription(block.name, block.input as Record<string, unknown>)
          });
        } else if (block.type === 'text') {
          textResponse += block.text;
        }
      }

      // If no tool calls, just return the text response
      if (proposedToolCalls.length === 0) {
        return new Response(
          JSON.stringify({
            ok: true,
            mode: 'draft',
            response: textResponse || 'How can I help you?',
            proposed_tool_calls: [],
            requires_confirmation: false
          } as AiAssistantResponse),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if confirmation will be required
      const requiresConfirmation = hasHighRiskTools(proposedToolCalls.map(tc => ({ name: tc.tool })));

      // Generate token for execute phase
      const actionsToken = await createActionsToken(requestData.device_id, proposedToolCalls);

      // Audit log the draft proposal
      if (proposedToolCalls.length > 0) {
        await supabase.from('audit_log').insert({
          action: 'ai_assistant_draft',
          entity_type: 'ai_assistant',
          entity_id: requestData.device_id,
          device_id: requestData.device_id,
          device_type: requestData.device_type,
          initiated_by: 'ai_assistant',
          request_data: {
            prompt: requestData.prompt,
            mode: 'draft',
            proposed_tools: proposedToolCalls.map(tc => tc.tool)
          },
          outcome: 'success'
        });
      }

      return new Response(
        JSON.stringify({
          ok: true,
          mode: 'draft',
          response: textResponse || 'I can help with that. Please review the proposed actions below.',
          proposed_tool_calls: proposedToolCalls,
          actions_token: actionsToken,
          requires_confirmation: requiresConfirmation
        } as AiAssistantResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // === READ MODE: Execute read-only tools immediately (they're safe) ===
    if (mode === 'read') {
      // Continue to existing tool execution - read-only tools are already filtered
    }

    // === EXECUTE MODE: Verify token and execute proposed actions ===
    if (mode === 'execute') {
      // Verify the actions token
      const tokenResult = await verifyActionsToken(actionsToken!, requestData.device_id);
      if (!tokenResult.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: tokenResult.error }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const proposedCalls = tokenResult.proposedCalls;

      // Check if high-risk actions require confirmation
      const hasHighRisk = hasHighRiskTools(proposedCalls.map(tc => ({ name: tc.tool })));
      if (hasHighRisk && !confirmDestructive) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'High-risk actions require confirmation. Set confirm_destructive: true.'
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Hard guard: max 5 actions per request
      if (proposedCalls.length > 5) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Too many actions. Maximum 5 per request.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Execute the proposed actions via existing endpoints
      const executedActions: AiAssistantResponse['executed_actions'] = [];
      const supabaseUrlExec = Deno.env.get('SUPABASE_URL')!;
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

      for (const call of proposedCalls) {
        try {
          const result = await executeToolViaEndpoint(
            call.tool,
            call.args,
            supabaseUrlExec,
            serviceRoleKey,
            requestData.device_id,
            supabase
          );
          executedActions.push({
            tool: call.tool,
            success: result.ok,
            result: result.data,
            error: result.error
          });
        } catch (err) {
          executedActions.push({
            tool: call.tool,
            success: false,
            error: err.message || 'Unknown error'
          });
        }
      }

      // Audit log the execution
      await supabase.from('audit_log').insert({
        action: 'ai_assistant_execute',
        entity_type: 'ai_assistant',
        entity_id: requestData.device_id,
        device_id: requestData.device_id,
        device_type: requestData.device_type,
        initiated_by: 'ai_assistant',
        request_data: {
          prompt: requestData.prompt,
          mode: 'execute',
          executed_tools: executedActions.map(a => a.tool),
          success: executedActions.every(a => a.success)
        },
        outcome: executedActions.every(a => a.success) ? 'success' : 'failure',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      });

      const allSucceeded = executedActions.every(a => a.success);
      return new Response(
        JSON.stringify({
          ok: allSucceeded,
          mode: 'execute',
          response: allSucceeded
            ? `Successfully executed ${executedActions.length} action(s).`
            : 'Some actions failed. See executed_actions for details.',
          executed_actions: executedActions
        } as AiAssistantResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ===========================================
    // PROCESS TOOL CALLS (for read mode - tools already filtered)
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
          tools: filteredTools,
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
