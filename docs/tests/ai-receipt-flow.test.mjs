import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AI_EXPECTED_TIME_COPY, AI_MAX_RETRY_AFTER_SECONDS, AI_POLL_ATTEMPTS, aiNetworkPollDecision, aiPollDecision, aiProgressMessage, aiRetryDelayMs, formatAiElapsed, MAX_TRANSIENT_POLL_FAILURES } from "../ai-receipt-flow.js";

test("pending and completed Sarvam results have explicit poll outcomes", () => {
  assert.deepEqual(aiPollDecision(202, "pending", 2), { kind: "wait", nextFailures: 0 });
  assert.deepEqual(aiPollDecision(202, "provider_pending"), { kind: "wait", nextFailures: 0 });
  assert.deepEqual(aiPollDecision(200, "completed", 2), { kind: "complete", nextFailures: 0 });
});

test("transient provider and network failures retry only within the bounded allowance", () => {
  assert.deepEqual(aiPollDecision(503, "provider_unavailable", 0), { kind: "retry", nextFailures: 1 });
  assert.deepEqual(aiPollDecision(429, "rate_or_cap_reached", 2), { kind: "retry", nextFailures: 3 });
  assert.equal(aiPollDecision(503, "provider_unavailable", MAX_TRANSIENT_POLL_FAILURES).kind, "fail");
  assert.equal(aiNetworkPollDecision(0).kind, "retry");
  assert.equal(aiNetworkPollDecision(MAX_TRANSIENT_POLL_FAILURES).kind, "fail");
  assert.equal(aiRetryDelayMs(99), 8000);
});

test("authentication, invalid result, and provider failure remain final", () => {
  assert.equal(aiPollDecision(401, "authentication_required").kind, "fail");
  assert.equal(aiPollDecision(422, "invalid_provider_result").kind, "fail");
  assert.equal(aiPollDecision(422, "provider_failed").kind, "fail");
});

test("Private AI progress reports measured elapsed time and the bounded polling window", () => {
  assert.equal(formatAiElapsed(1_000, 46_000), "45s elapsed");
  assert.equal(formatAiElapsed(1_000, 126_000), "2m 05s elapsed");
  assert.match(aiProgressMessage("Private AI is reading.", 1_000, 46_000), /45s elapsed.*checks run every 2–10 seconds/);
  assert.equal(AI_POLL_ATTEMPTS * AI_MAX_RETRY_AFTER_SECONDS, 400);
  assert.match(AI_EXPECTED_TIME_COPY, /up to about 7 minutes/);
});

test("website integration keeps a persistent accessible state and preserves the local draft on fallback", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /\$\("import-processing-copy"\)\.textContent = message/);
  assert.match(app, /aiProgressMessage\("Private AI is reading the approved derivative\."/);
  assert.match(app, /aiProgressMessage\(`Connection interrupted; retrying \$\{transientFailures\} of 3\.`/);
  assert.match(app, /function failAiPdfImport/);
  assert.match(app, /function cancelAiImport\(\)[\s\S]*pendingPdfImport = undefined;[\s\S]*Nothing was saved/);
  assert.match(app, /resolveAiReceiptTotal\(draftReference\.defaults\.amount, aiDraft\.defaults\.amount, aiDraft\.items\)/);
  assert.match(app, /amount: resolvedTotal\.amount/);
  assert.match(app, /parserWarning = \[resolvedTotal\.warning, aiNameWarning\]/);
  assert.match(app, /Nothing was saved/);
  assert.doesNotMatch(app, /\$\("prepare-ai"\)/);
  assert.doesNotMatch(app, /note\("Redacted derivative accepted/);
});
