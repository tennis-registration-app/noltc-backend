import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  endSession,
  signalBoardChange,
} from '../_shared/sessionLifecycle.ts';
import {
  successResponse,
  internalErrorResponse,
} from '../_shared/index.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ClearResult {
  sessionId: string;
  courtNumber: number;
  success: boolean;
  error?: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const serverNow = new Date().toISOString();

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 1. Read auto-clear settings
    const { data: settings, error: settingsError } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', ['auto_clear_enabled', 'auto_clear_minutes']);

    if (settingsError) {
      console.error('Failed to read settings:', settingsError);
      return addCorsHeaders(internalErrorResponse('Failed to read settings', serverNow));
    }

    const settingsMap: Record<string, string> = {};
    for (const s of settings || []) {
      settingsMap[s.key] = s.value;
    }

    const autoClearEnabled = settingsMap.auto_clear_enabled === 'true';
    const autoClearMinutes = parseInt(settingsMap.auto_clear_minutes || '180', 10);

    // 2. If disabled, return early
    if (!autoClearEnabled) {
      return addCorsHeaders(
        successResponse(
          {
            cleared: 0,
            message: 'Auto-clear is disabled',
          },
          serverNow
        )
      );
    }

    // 3. Calculate cutoff time
    const cutoffTime = new Date(Date.now() - autoClearMinutes * 60 * 1000).toISOString();

    // 4. Query for stale sessions
    const { data: staleSessions, error: queryError } = await supabase
      .from('sessions')
      .select(`
        id,
        started_at,
        court_id,
        courts!inner (
          court_number
        )
      `)
      .is('actual_end_at', null)
      .lt('started_at', cutoffTime)
      .order('started_at', { ascending: true });

    if (queryError) {
      console.error('Failed to query sessions:', queryError);
      return addCorsHeaders(internalErrorResponse('Failed to query sessions', serverNow));
    }

    if (!staleSessions || staleSessions.length === 0) {
      return addCorsHeaders(
        successResponse(
          {
            cleared: 0,
            message: 'No stale sessions to clear',
          },
          serverNow
        )
      );
    }

    // 5. End each stale session
    const results: ClearResult[] = [];
    let clearedCount = 0;

    for (const session of staleSessions) {
      const courtNumber = (session.courts as any)?.court_number || 0;

      try {
        const result = await endSession(supabase, {
          sessionId: session.id,
          serverNow,
          endReason: 'auto_cleared',
          deviceId: undefined,
          eventData: {
            auto_clear_minutes: autoClearMinutes,
            started_at: session.started_at,
          },
        });

        if (result.success) {
          clearedCount++;
          results.push({
            sessionId: session.id,
            courtNumber,
            success: true,
          });
        } else if (result.alreadyEnded) {
          results.push({
            sessionId: session.id,
            courtNumber,
            success: true,
            error: 'Already ended',
          });
        } else {
          results.push({
            sessionId: session.id,
            courtNumber,
            success: false,
            error: result.error || 'Unknown error',
          });
          console.error(`[auto-clear-sessions] Failed to clear session ${session.id}: ${result.error}`);
        }
      } catch (err) {
        results.push({
          sessionId: session.id,
          courtNumber,
          success: false,
          error: err.message || 'Exception',
        });
        console.error(`[auto-clear-sessions] Exception clearing session ${session.id}:`, err);
      }
    }

    // Signal board change if any sessions were cleared
    if (clearedCount > 0) {
      await signalBoardChange(supabase, 'session');
    }

    // 6. Return summary
    return addCorsHeaders(
      successResponse(
        {
          cleared: clearedCount,
          total: staleSessions.length,
          message: clearedCount > 0
            ? `Auto-cleared ${clearedCount} session(s)`
            : 'No sessions cleared',
          results,
        },
        serverNow
      )
    );

  } catch (error) {
    console.error('[auto-clear-sessions] Unexpected error:', error);
    return addCorsHeaders(internalErrorResponse(error.message, serverNow));
  }
});

/**
 * Add CORS headers to a response
 */
function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
