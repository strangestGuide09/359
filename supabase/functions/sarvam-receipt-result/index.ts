import { createClient } from "npm:@supabase/supabase-js@2";
import { boundedProviderJson } from "../_shared/receipt-contract.mjs";
import { fixedCompletionError, mapProviderReceipt, providerState } from "./result-mapper.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const response = (status: number, code: string, extra = {}, origin?: string, retryAfter?: number) => new Response(JSON.stringify({ code, ...extra }), { status, headers: {
  "content-type": "application/json", "cache-control": "no-store",
  ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
  ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "authorization, apikey, content-type", "vary": "Origin" } : {})
} });

Deno.serve(async request => {
  let responseOrigin: string | undefined;
  let serverClient;
  let jobId: string | undefined;
  try {
    const allowedOrigin = Deno.env.get("AI_ALLOWED_ORIGIN");
    const requestOrigin = request.headers.get("origin") || "";
    if (allowedOrigin && requestOrigin === allowedOrigin) responseOrigin = allowedOrigin;
    if (request.method === "OPTIONS") return responseOrigin ? response(200, "ok", {}, responseOrigin) : response(403, "origin_not_allowed");
    if (request.method !== "POST") return response(405, "method_not_allowed", {}, responseOrigin);
    if (Deno.env.get("AI_PROCESSING_ENABLED") !== "true") throw new Error("processing_disabled");
    if (!responseOrigin) throw new Error("origin_not_allowed");
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) throw new Error("authentication_required");
    if (Number(request.headers.get("content-length") || 0) > 4096) throw new Error("job_not_found");

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const sarvamKey = Deno.env.get("SARVAM_API_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey || !sarvamKey) throw new Error("processing_disabled");
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    serverClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error("authentication_required");

    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > 4096) throw new Error("job_not_found");
    let body;
    try { body = JSON.parse(bodyText || "{}"); } catch { throw new Error("job_not_found"); }
    jobId = String(body.job_id || "");
    const householdId = String(body.household_id || "");
    if (!uuid.test(jobId) || !uuid.test(householdId)) throw new Error("job_not_found");
    const { data: rows, error: claimError } = await serverClient.rpc("claim_ai_parse_completion", { p_job_id: jobId, p_household_id: householdId, p_requesting_user: authData.user.id });
    if (claimError) throw new Error(/disabled/i.test(claimError.message) ? "processing_disabled" : /not found|membership/i.test(claimError.message) ? "job_not_found" : "provider_unavailable");
    const claim = Array.isArray(rows) ? rows[0] : rows;
    if (!claim) throw new Error("job_not_found");
    if (["failed","cancelled"].includes(claim.job_state)) throw new Error(claim.fixed_error_code || (claim.job_state === "cancelled" ? "completion_timeout" : "provider_failed"));
    if (claim.job_state === "reserved" || claim.retry_after_seconds > 0 || !claim.provider_job_id) return response(202, "pending", {}, responseOrigin, Math.max(2, claim.retry_after_seconds || 2));

    const providerJobId = String(claim.provider_job_id);
    const headers = { "api-subscription-key": sarvamKey };
    let status;
    try {
      status = await boundedProviderJson(`https://api.sarvam.ai/doc-ai/v1/job/${encodeURIComponent(providerJobId)}/status`, { method: "GET", headers }, 65536);
    } catch (error) {
      throw new Error(providerCompletionCode(error));
    }
    const state = providerState(status, providerJobId, Number(claim.page_count));
    if (state === "pending") return response(202, "pending", {}, responseOrigin, 3);
    if (state === "failed") {
      await finish(serverClient, jobId, "failed", "provider_failed", 0);
      throw new Error("provider_failed");
    }
    let result;
    try {
      result = await boundedProviderJson(`https://api.sarvam.ai/doc-ai/v1/job/${encodeURIComponent(providerJobId)}/results?format=json`, { method: "GET", headers });
    } catch (error) {
      throw new Error(providerCompletionCode(error));
    }
    const draft = mapProviderReceipt(result, providerJobId, Number(claim.page_count));
    const pages = Number(result?.usage?.pages_processed);
    const chargedUnits = Number.isInteger(pages) && pages >= 0 && pages <= Number(claim.page_count) ? pages : Number(claim.page_count);
    if (claim.job_state !== "completed") await finish(serverClient, jobId, "completed", null, chargedUnits);
    return response(200, "completed", { draft }, responseOrigin);
  } catch (error) {
    const code = fixedCompletionError(error);
    if (jobId && serverClient && code === "invalid_provider_result") await finish(serverClient, jobId, "failed", code, 0).catch(() => undefined);
    const status = code === "authentication_required" ? 401 : code === "origin_not_allowed" || code === "provider_access_denied" ? 403 : code === "job_not_found" ? 404 : code === "processing_disabled" || ["provider_unavailable", "provider_connection_failed", "provider_timeout", "provider_job_unavailable", "provider_service_unavailable"].includes(code) ? 503 : code === "provider_rate_limited" ? 429 : code === "provider_pending" ? 202 : 422;
    return response(status, code, {}, responseOrigin, code === "provider_pending" ? 3 : undefined);
  }
});

async function finish(client, jobId: string, state: string, errorCode: string | null, chargedUnits: number) {
  const { error } = await client.rpc("mark_ai_parse_finished", { p_job_id: jobId, p_state: state, p_fixed_error_code: errorCode, p_charged_units: chargedUnits });
  if (error) throw new Error("provider_unavailable");
}

function providerCompletionCode(error: unknown) {
  const status = Number((error as { status?: number })?.status);
  if ([401, 402, 403].includes(status)) return "provider_access_denied";
  if (status === 404) return "provider_job_unavailable";
  if ([400, 413, 422].includes(status)) return "provider_request_rejected";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500 && status <= 599) return "provider_service_unavailable";
  if ((error as Error)?.message === "provider_timeout") return "provider_timeout";
  if ((error as Error)?.message === "invalid_provider_result") return "invalid_provider_result";
  return "provider_connection_failed";
}
