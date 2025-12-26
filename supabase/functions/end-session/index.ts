import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { endSession, signalBoardChange, findAllActiveSessionsOnCourt } from '../_shared/sessionLifecycle.ts'

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
    const { session_id, court_id, end_reason, device_id } = body
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

      // Find ALL active sessions on this court (handles stale data)
      const activeSessions = await findAllActiveSessionsOnCourt(supabase, resolvedCourtId)

      if (!activeSessions || activeSessions.length === 0) {
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

      // Log if multiple sessions found (indicates stale data issue)
      if (activeSessions.length > 1) {
        console.warn(`⚠️ Found ${activeSessions.length} active sessions on court ${resolvedCourtId} - ending all`)
      }

      // End ALL sessions on this court
      let sessionsEnded = 0
      for (const session of activeSessions) {
        const result = await endSession(supabase, {
          sessionId: session.id,
          serverNow,
          endReason: end_reason || 'completed',
          deviceId: device_id,
        })
        if (result.success || result.alreadyEnded) {
          sessionsEnded++
        }
      }

      console.log(`Ended ${sessionsEnded}/${activeSessions.length} sessions on court ${resolvedCourtId}`)

      // Signal board change
      await signalBoardChange(supabase, 'session')

      return new Response(
        JSON.stringify({
          ok: true,
          serverNow,
          sessionsEnded,
          message: sessionsEnded > 1 ? `Ended ${sessionsEnded} sessions` : 'Session ended',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // If session_id was provided directly, end just that session
    const result = await endSession(supabase, {
      sessionId: targetSessionId,
      serverNow,
      endReason: end_reason || 'completed',
      deviceId: device_id,
    })

    if (result.alreadyEnded) {
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

    if (!result.success) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'END_SESSION_FAILED',
          message: result.error || 'Failed to end session',
          serverNow,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    // Signal board change for real-time updates
    await signalBoardChange(supabase, 'session')

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
