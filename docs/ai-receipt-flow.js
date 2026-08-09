export const MAX_TRANSIENT_POLL_FAILURES = 3;

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
