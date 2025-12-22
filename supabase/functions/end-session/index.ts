import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json()
    const { session_id, court_id, end_reason } = body
    const serverNow = new Date().toISOString()

    // Validate: need either session_id or court_id
    if (!session_id && !court_id) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'MISSING_IDENTIFIER',
          message: 'Either session_id or court_id is required',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    let targetSessionId = session_id
    let resolvedCourtId = court_id

    // If court_id provided, find the active session for that court
    if (!targetSessionId && court_id) {
      // Determine if court_id is a UUID or a court number
      const isUUID = typeof court_id === 'string' && court_id.includes('-')
      
      if (isUUID) {
        // court_id is already a UUID
        resolvedCourtId = court_id
      } else {
        // court_id is a court number, look up the UUID
        const courtNumber = parseInt(court_id, 10)
        if (isNaN(courtNumber)) {
          return new Response(
            JSON.stringify({
              ok: false,
              code: 'INVALID_COURT_ID',
              message: `Invalid court_id: ${court_id}`,
              serverNow,
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
          )
        }
        
        const { data: courtData, error: courtError } = await supabase
          .from('courts')
          .select('id')
          .eq('court_number', courtNumber)
          .single()
        
        if (courtError || !courtData) {
          return new Response(
            JSON.stringify({
              ok: false,
              code: 'COURT_NOT_FOUND',
              message: `Court ${courtNumber} not found`,
              serverNow,
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
          )
        }
        
        resolvedCourtId = courtData.id
      }

      // Find active session on this court (no END event exists)
      const { data: activeSession, error: sessionError } = await supabase
        .from('sessions')
        .select('id')
        .eq('court_id', resolvedCourtId)
        .is('actual_end_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .single()

      if (sessionError || !activeSession) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'NO_ACTIVE_SESSION',
            message: `No active session found on court ${court_id}`,
            serverNow,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
        )
      }

      targetSessionId = activeSession.id
    }

    // Insert END event (append-only pattern)
    // The unique partial index on (session_id, event_type) WHERE event_type = 'END'
    // ensures idempotency - duplicate END inserts will fail
    const { error: eventError } = await supabase
      .from('session_events')
      .insert({
        session_id: targetSessionId,
        event_type: 'END',
        event_data: { 
          reason: end_reason || 'completed',
          ended_at: serverNow 
        },
        created_by: null, // Could be device_id if passed
      })

    if (eventError) {
      // Check for unique constraint violation (session already ended)
      if (eventError.code === '23505') {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'SESSION_ALREADY_ENDED',
            message: 'This session has already been ended',
            serverNow,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 409 }
        )
      }
      
      console.error('Event insert error:', eventError)
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'EVENT_INSERT_FAILED',
          message: eventError.message,
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    // Insert board change signal for real-time updates
    await supabase
      .from('board_change_signals')
      .insert({ change_type: 'session' })

    // Get session details for response
    const { data: session } = await supabase
      .from('sessions')
      .select('id, court_id, started_at, session_type')
      .eq('id', targetSessionId)
      .single()

    return new Response(
      JSON.stringify({
        ok: true,
        serverNow,
        session: session ? {
          id: session.id,
          courtId: session.court_id,
          startedAt: session.started_at,
          endedAt: serverNow,
          sessionType: session.session_type,
        } : null,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: error.message,
        serverNow: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
