import { createClient } from "npm:@supabase/supabase-js@2";
import { fixedError, hasAllowedMagic, inspectSanitizedPdf, MAX_DERIVATIVE_BYTES, validateMetadata } from "./validation.mjs";
import { boundedProviderJson, RECEIPT_EXTRACTION_SCHEMA } from "../_shared/receipt-contract.mjs";

const response = (status: number, code: string, extra = {}, origin?: string) => new Response(status === 204 ? null : JSON.stringify({ code, ...extra }), { status, headers: {
  "content-type": "application/json", "cache-control": "no-store",
  ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "authorization, apikey, content-type", "vary": "Origin" } : {})
} });

Deno.serve(async request => {
  let jobId: string | undefined;
  let userClient;
  let serverClient;
  let derivativeBytes: Uint8Array | undefined;
  let responseOrigin: string | undefined;
  try {
    const allowedOrigin = Deno.env.get("AI_ALLOWED_ORIGIN");
    const requestOrigin = request.headers.get("origin") || "";
    if (allowedOrigin && requestOrigin === allowedOrigin) responseOrigin = allowedOrigin;
    if (request.method === "OPTIONS") return responseOrigin ? response(204, "ok", {}, responseOrigin) : response(403, "origin_not_allowed");
    if (request.method !== "POST") return response(405, "method_not_allowed", {}, responseOrigin);
    if (Deno.env.get("AI_PROCESSING_ENABLED") !== "true") throw new Error("processing_disabled");
    if (!responseOrigin) throw new Error("origin_not_allowed");
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) throw new Error("authentication_required");
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_DERIVATIVE_BYTES + 65536) throw new Error("invalid_payload_size");

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error("processing_disabled");
    userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    serverClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error("authentication_required");

    const form = await request.formData();
    const derivative = form.get("derivative");
    if (!(derivative instanceof File)) throw new Error("sanitized_derivative_required");
    derivativeBytes = new Uint8Array(await derivative.arrayBuffer());
    const metadata = {
      householdId: String(form.get("household_id") || ""),
      idempotencyKey: String(form.get("idempotency_key") || ""),
      sanitizerVersion: String(form.get("sanitizer_version") || ""),
      mime: derivative.type,
      pageCount: Number(form.get("page_count")),
      byteCount: derivativeBytes.byteLength,
      sanitized: String(form.get("sanitized") || "")
    };
    validateMetadata(metadata);
    if (!hasAllowedMagic(derivativeBytes, metadata.mime)) throw new Error("invalid_file_signature");
    inspectSanitizedPdf(derivativeBytes, metadata.sanitizerVersion, metadata.pageCount);

    const { data: reserved, error: reserveError } = await userClient.rpc("reserve_ai_parse", {
      p_household_id: metadata.householdId,
      p_idempotency_key: metadata.idempotencyKey,
      p_sanitizer_version: metadata.sanitizerVersion,
      p_derivative_mime: metadata.mime,
      p_derivative_bytes: metadata.byteCount,
      p_page_count: metadata.pageCount
    });
    if (reserveError) throw new Error(/limit|cap/i.test(reserveError.message) ? "rate_or_cap_reached" : "processing_disabled");
    const reservation = Array.isArray(reserved) ? reserved[0] : reserved;
    jobId = reservation?.job_id;
    if (!jobId) throw new Error("processing_disabled");
    const { data: claimed, error: claimError } = await serverClient.rpc("claim_ai_parse_submission", { p_job_id: jobId, p_requesting_user: authData.user.id });
    if (claimError) throw new Error(/disabled/i.test(claimError.message) ? "processing_disabled" : "submission_claim_failed");
    if (claimed !== true) return response(202, "accepted", { job_id: jobId }, responseOrigin);

    const sarvamKey = Deno.env.get("SARVAM_API_KEY");
    if (!sarvamKey) throw new Error("processing_disabled");
    let providerJobId: string;
    try {
      providerJobId = await createSarvamExtractJob(sarvamKey, derivativeBytes, metadata.mime);
    } catch (error) {
      throw new Error(providerSubmissionCode(error));
    }
    const { error: startedError } = await serverClient.rpc("mark_ai_parse_started", { p_job_id: jobId, p_provider_job_id: providerJobId });
    if (startedError) throw new Error("provider_job_record_failed");
    return response(202, "accepted", { job_id: jobId }, responseOrigin);
  } catch (error) {
    const code = fixedError(error);
    if (jobId && serverClient) await serverClient.rpc("mark_ai_parse_finished", { p_job_id: jobId, p_state: "failed", p_fixed_error_code: code, p_charged_units: 0 });
    return response(code === "authentication_required" ? 401 : code === "origin_not_allowed" ? 403 : code === "rate_or_cap_reached" ? 429 : code === "processing_disabled" ? 503 : 400, code, {}, responseOrigin);
  } finally {
    derivativeBytes?.fill(0);
  }
});

async function createSarvamExtractJob(apiKey: string, bytes: Uint8Array, mime: string) {
  const form = new FormData();
  form.set("file", new File([bytes], "sanitized-receipt.pdf", { type: mime }));
  form.set("schema", JSON.stringify(RECEIPT_EXTRACTION_SCHEMA));
  form.set("language", "en-IN");
  form.set("output_format", "json");
  const created = await boundedProviderJson("https://api.sarvam.ai/doc-ai/v1/job/extract", { method: "POST", headers: { "api-subscription-key": apiKey }, body: form }, 65536);
  const providerJobId = String(created.job_id || "");
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(providerJobId) || !["pending","queued","running","accepted","created"].includes(String(created.status || "").toLowerCase())) throw new Error("provider_invalid_response");
  return providerJobId;
}

function providerSubmissionCode(error: unknown) {
  const status = Number((error as { status?: number })?.status);
  if ([401, 402, 403].includes(status)) return "provider_access_denied";
  if ([400, 413, 422].includes(status)) return "provider_request_rejected";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500 && status <= 599) return "provider_service_unavailable";
  if ((error as Error)?.message === "provider_timeout") return "provider_timeout";
  if ((error as Error)?.message === "invalid_provider_result" || (error as Error)?.message === "provider_invalid_response") return "provider_invalid_response";
  return "provider_connection_failed";
}
