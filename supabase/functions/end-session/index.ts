// supabase/functions/end-session/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { session_id, court_id, end_reason, device_id } = await req.json();
    const serverNow = new Date().toISOString();

    // Validate request - need either session_id or court_id
    if (!session_id && !court_id) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'INVALID_REQUEST',
        message: 'Either session_id or court_id is required',
        serverNow
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify device if provided
    if (device_id) {
      const { error: deviceError } = await supabase
        .from('devices')
        .update({ last_seen_at: serverNow })
        .eq('id', device_id);

      if (deviceError) {
        console.error('Device update error:', deviceError);
      }
    }

    // Find the active session
    let sessionQuery = supabase
      .from('sessions')
      .select(`
        id,
        court_id,
        session_type,
        started_at,
        scheduled_end_at,
        courts!inner(court_number)
      `)
      .is('actual_end_at', null);

    if (session_id) {
      sessionQuery = sessionQuery.eq('id', session_id);
    } else {
      // court_id can be either a UUID or a court number (1-12)
      const isUUID = court_id.includes('-');
      let courtUUID = court_id;

      if (!isUUID) {
        // Look up court UUID from court number
        const { data: court } = await supabase
          .from('courts')
          .select('id')
          .eq('court_number', parseInt(court_id))
          .single();

        if (!court) {
          return new Response(JSON.stringify({
            ok: false,
            code: 'COURT_NOT_FOUND',
            message: `Court ${court_id} not found`,
            serverNow
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        courtUUID = court.id;
      }

      sessionQuery = sessionQuery.eq('court_id', courtUUID);
    }

    const { data: session, error: sessionError } = await sessionQuery.single();

    if (sessionError || !session) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'SESSION_NOT_FOUND',
        message: 'No active session found',
        serverNow
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get participants for response
    const { data: participants } = await supabase
      .from('session_participants')
      .select(`
        member_id,
        participant_type,
        guest_name,
        members(display_name, accounts(member_number))
      `)
      .eq('session_id', session.id);

    // INSERT END event into session_events (append-only pattern)
    const { error: eventError } = await supabase
      .from('session_events')
      .insert({
        session_id: session.id,
        event_type: 'END',
        event_data: {
          reason: end_reason || 'normal',
          ended_by: device_id || 'user',
          ended_at: serverNow
        },
        created_by: device_id || 'system'
      });

    if (eventError) {
      console.error('Session event insert error:', eventError);
      
      // Check if it's a duplicate END event (unique constraint violation)
      if (eventError.code === '23505') {
        // Even though event exists, ensure actual_end_at is set (recovery for past bugs)
        // Valid end_reason values: 'completed', 'cleared_early'
        const validReason = ['completed', 'cleared_early'].includes(end_reason)
          ? end_reason
          : 'cleared_early';

        await supabase
          .from('sessions')
          .update({
            actual_end_at: serverNow,
            end_reason: validReason
          })
          .eq('id', session.id);

        return new Response(JSON.stringify({
          ok: false,
          code: 'SESSION_ALREADY_ENDED',
          message: 'This session has already been ended',
          serverNow
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        ok: false,
        code: 'EVENT_ERROR',
        message: 'Failed to end session',
        serverNow
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Update session with actual end time
    const { error: updateError } = await supabase
      .from('sessions')
      .update({
        actual_end_at: serverNow,
        end_reason: end_reason || 'normal'
      })
      .eq('id', session.id);

    if (updateError) {
      console.error('Session update error:', updateError);
      // Don't fail the request - the event was recorded, this is for denormalization
    }

    // Calculate actual duration
    const startedAt = new Date(session.started_at);
    const endedAt = new Date(serverNow);
    const actualDurationMinutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000);

    // Audit log
    await supabase.from('audit_log').insert({
      action: 'session_ended',
      entity_type: 'session',
      entity_id: session.id,
      details: {
        court_number: session.courts?.court_number,
        end_reason: end_reason || 'normal',
        actual_duration_minutes: actualDurationMinutes,
        participant_count: participants?.length || 0
      },
      performed_by: device_id || 'system'
    });

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      session: {
        id: session.id,
        courtNumber: session.courts?.court_number,
        sessionType: session.session_type,
        startedAt: session.started_at,
        endedAt: serverNow,
        actualDurationMinutes,
        participants: (participants || []).map(p => ({
          memberId: p.member_id,
          displayName: p.participant_type === 'guest' ? p.guest_name : p.members?.display_name,
          memberNumber: p.members?.accounts?.member_number,
          isGuest: p.participant_type === 'guest'
        }))
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Unexpected error:', error);
    return new Response(JSON.stringify({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      serverNow: new Date().toISOString()
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
