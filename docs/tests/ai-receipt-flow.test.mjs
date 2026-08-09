import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { aiNetworkPollDecision, aiPollDecision, aiRetryDelayMs, MAX_TRANSIENT_POLL_FAILURES } from "../ai-receipt-flow.js";

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

test("website integration keeps a persistent accessible state and preserves the local draft on fallback", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /aiProcessingStatus\.setAttribute\("role", "status"\)/);
  assert.match(app, /setAiProcessing\("Sarvam is reading the redacted receipt\. Your local draft remains available…", true\)/);
  assert.match(app, /Retrying AI result \$\{transientFailures\} of 3; your local draft is safe/);
  assert.match(app, /Continue reviewing or save the local draft/);
  assert.match(app, /\$\("prepare-ai"\)\.disabled = busy/);
  assert.doesNotMatch(app, /note\("Redacted derivative accepted/);
});
