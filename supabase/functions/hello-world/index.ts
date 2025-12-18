import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Create Supabase client with service role (bypasses RLS)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Parse request body if present
    let requestData = {}
    try {
      if (req.body) {
        requestData = await req.json()
      }
    } catch {
      // No body or invalid JSON is fine for hello-world
    }

    // Read test: Get court count
    const { data: courts, error: courtsError } = await supabase
      .from('courts')
      .select('id', { count: 'exact' })

    if (courtsError) {
      throw new Error(`Failed to read courts: ${courtsError.message}`)
    }

    // Read test: Get system settings
    const { data: settings, error: settingsError } = await supabase
      .from('system_settings')
      .select('key, value')

    if (settingsError) {
      throw new Error(`Failed to read settings: ${settingsError.message}`)
    }

    // Write test: Log to audit_log
    const { error: auditError } = await supabase
      .from('audit_log')
      .insert({
        action: 'hello_world',
        entity_type: 'system',
        entity_id: '00000000-0000-0000-0000-000000000000',
        device_id: null,
        device_type: requestData.device_type || 'unknown',
        initiated_by: 'system',
        request_data: requestData,
        outcome: 'success',
        ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      })

    if (auditError) {
      throw new Error(`Failed to write audit log: ${auditError.message}`)
    }

    // Success response
    const response = {
      ok: true,
      message: 'Hello from NOLTC Backend!',
      timestamp: new Date().toISOString(),
      checks: {
        database_read: true,
        database_write: true,
        court_count: courts?.length || 0,
        settings_count: settings?.length || 0,
      },
      settings: settings?.reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {}),
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    // Log failure to audit if possible
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      const supabase = createClient(supabaseUrl, supabaseServiceKey)

      await supabase.from('audit_log').insert({
        action: 'hello_world',
        entity_type: 'system',
        entity_id: '00000000-0000-0000-0000-000000000000',
        initiated_by: 'system',
        outcome: 'failure',
        error_message: error.message,
      })
    } catch {
      // Ignore audit log failure in error handler
    }

    return new Response(JSON.stringify({
      ok: false,
      error: error.message
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
