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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const serverNow = new Date().toISOString()
  const sessionId = '75ab7b75-a212-43cd-9dba-3b9cc80706be'

  // Insert RESTORE event
  const { data, error } = await supabase
    .from('session_events')
    .insert({
      session_id: sessionId,
      event_type: 'RESTORE',
      event_data: {
        trigger: 'manual_fix',
        restored_at: serverNow,
        note: 'Fix for missing RESTORE event after migration added RESTORE type',
      },
    })
    .select()

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true, data, serverNow }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
