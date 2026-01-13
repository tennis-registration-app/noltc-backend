import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface UsageComparisonRequest {
  metric: "usage" | "waittime";
  primaryStart: string;
  primaryEnd: string;
  granularity: "auto" | "day" | "week" | "month";
  comparisonStart?: string | null;
}

interface Bucket {
  bucketStart: string;
  bucketEnd: string;
  label: string;
  labelFull: string;
  value: number;
}

interface UsageComparisonResponse {
  ok: boolean;
  metric: "usage" | "waittime";
  unit: "hours" | "minutes";
  granularity: "day" | "week" | "month";
  primary: {
    startDate: string;
    endDate: string;
    buckets: Bucket[];
  };
  comparison: {
    startDate: string;
    endDate: string;
    buckets: Bucket[];
  } | null;
}

function toStartOfDayCentral(dateStr: string): string {
  return `${dateStr}T00:00:00-06:00`;
}

function toEndOfDayCentral(dateStr: string): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + 1);
  const nextDay = date.toISOString().split("T")[0];
  return `${nextDay}T00:00:00-06:00`;
}

function daysBetween(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

function autoGranularity(days: number): "day" | "week" | "month" {
  if (days <= 31) return "day";
  if (days <= 120) return "week";
  return "month";
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: UsageComparisonRequest = await req.json();
    const { metric, primaryStart, primaryEnd, granularity, comparisonStart } = body;

    if (metric !== "usage" && metric !== "waittime") {
      return new Response(
        JSON.stringify({ error: "Invalid metric. Must be 'usage' or 'waittime'." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!primaryStart || !primaryEnd) {
      return new Response(
        JSON.stringify({ error: "primaryStart and primaryEnd are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const days = daysBetween(primaryStart, primaryEnd);
    const effectiveGranularity = granularity === "auto"
      ? autoGranularity(days)
      : granularity;

    const primaryStartTs = toStartOfDayCentral(primaryStart);
    const primaryEndTs = toEndOfDayCentral(primaryEnd);

    // Choose SQL function based on metric
    const sqlFunction = metric === "usage" ? "get_usage_by_period" : "get_waittime_by_period";

    const { data: primaryData, error: primaryError } = await supabase
      .rpc(sqlFunction, {
        p_start_ts: primaryStartTs,
        p_end_ts: primaryEndTs,
        p_granularity: effectiveGranularity,
      });

    if (primaryError) {
      console.error("Primary query error:", primaryError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch primary data", details: primaryError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const primaryBuckets: Bucket[] = (primaryData || []).map((row: any) => ({
      bucketStart: row.bucket_start,
      bucketEnd: row.bucket_end,
      label: row.label,
      labelFull: row.label_full,
      value: parseFloat(row.value) || 0,
    }));

    const response: UsageComparisonResponse = {
      ok: true,
      metric: metric,
      unit: metric === "usage" ? "hours" : "minutes",
      granularity: effectiveGranularity,
      primary: {
        startDate: primaryStart,
        endDate: primaryEnd,
        buckets: primaryBuckets,
      },
      comparison: null,
    };

    if (comparisonStart) {
      const comparisonEnd = addDays(comparisonStart, days - 1);

      const comparisonStartTs = toStartOfDayCentral(comparisonStart);
      const comparisonEndTs = toEndOfDayCentral(comparisonEnd);

      const { data: comparisonData, error: comparisonError } = await supabase
        .rpc(sqlFunction, {
          p_start_ts: comparisonStartTs,
          p_end_ts: comparisonEndTs,
          p_granularity: effectiveGranularity,
        });

      if (comparisonError) {
        console.error("Comparison query error:", comparisonError);
      } else {
        const comparisonBuckets: Bucket[] = (comparisonData || []).map((row: any) => ({
          bucketStart: row.bucket_start,
          bucketEnd: row.bucket_end,
          label: row.label,
          labelFull: row.label_full,
          value: parseFloat(row.value) || 0,
        }));

        response.comparison = {
          startDate: comparisonStart,
          endDate: comparisonEnd,
          buckets: comparisonBuckets,
        };
      }
    }

    return new Response(
      JSON.stringify(response),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
