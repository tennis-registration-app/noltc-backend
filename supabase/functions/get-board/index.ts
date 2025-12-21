// supabase/functions/get-board/index.ts
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

    // Single timestamp for consistency
    const serverNow = new Date().toISOString();

    // Get court board using the exact same timestamp
    const { data: courts, error: courtsError } = await supabase
      .rpc('get_court_board', { request_time: serverNow });

    if (courtsError) {
      console.error('Courts query error:', courtsError);
      return new Response(JSON.stringify({ 
        ok: false, 
        code: 'QUERY_ERROR', 
        message: 'Failed to load courts',
        serverNow
      }), { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get active waitlist using the same timestamp
    const { data: waitlist, error: waitlistError } = await supabase
      .rpc('get_active_waitlist', { request_time: serverNow });

    if (waitlistError) {
      console.error('Waitlist query error:', waitlistError);
      return new Response(JSON.stringify({ 
        ok: false, 
        code: 'QUERY_ERROR', 
        message: 'Failed to load waitlist',
        serverNow
      }), { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get operating hours
    const { data: operatingHours } = await supabase
      .from('operating_hours')
      .select('*')
      .order('day_of_week');

    return new Response(JSON.stringify({
      ok: true,
      serverNow,
      courts: courts || [],
      waitlist: waitlist || [],
      operatingHours: operatingHours || [],
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Unexpected error:', error);
    return new Response(JSON.stringify({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      serverNow: new Date().toISOString(),
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
