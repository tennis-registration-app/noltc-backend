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

  // Query constraints on session_events
  const { data: constraints, error: e1 } = await supabase.rpc('exec_sql', {
    sql: `
      SELECT conname, contype, pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = 'session_events'::regclass
    `
  })

  // Query indexes on session_events
  const { data: indexes, error: e2 } = await supabase.rpc('exec_sql', {
    sql: `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'session_events'
    `
  })

  // If RPC doesn't work, try direct query on information_schema
  const { data: tableConstraints, error: e3 } = await supabase
    .from('information_schema.table_constraints' as any)
    .select('constraint_name, constraint_type')
    .eq('table_name', 'session_events')

  return new Response(JSON.stringify({
    constraints,
    indexes,
    tableConstraints,
    errors: { e1: e1?.message, e2: e2?.message, e3: e3?.message },
  }, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
