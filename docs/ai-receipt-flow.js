export const MAX_TRANSIENT_POLL_FAILURES = 3;
export const AI_POLL_ATTEMPTS = 40;
export const AI_MAX_RETRY_AFTER_SECONDS = 10;
export const AI_EXPECTED_TIME_COPY = "Status checks run every 2–10 seconds and can continue for up to about 7 minutes.";

export function formatAiElapsed(startedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s elapsed`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s elapsed`;
}

export function aiProgressMessage(stage, startedAt, now = Date.now()) {
  return `${stage} ${formatAiElapsed(startedAt, now)}. ${AI_EXPECTED_TIME_COPY}`;
}

export function aiPollDecision(status, code, transientFailures = 0) {
  if (status === 202 && ["pending", "provider_pending"].includes(code)) return { kind: "wait", nextFailures: 0 };
  if (status >= 200 && status < 300 && code === "completed") return { kind: "complete", nextFailures: 0 };
  if ((status === 429 || status >= 500) && transientFailures < MAX_TRANSIENT_POLL_FAILURES) return { kind: "retry", nextFailures: transientFailures + 1 };
  return { kind: "fail", nextFailures: transientFailures };
}

export function aiNetworkPollDecision(transientFailures = 0) {
  return transientFailures < MAX_TRANSIENT_POLL_FAILURES
    ? { kind: "retry", nextFailures: transientFailures + 1 }
    : { kind: "fail", nextFailures: transientFailures };
}

export function aiRetryDelayMs(failures) {
  return Math.min(8000, Math.max(2000, Number(failures || 1) * 2000));
}
