import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createResilientAuthStorage, restoreSessionWithRetry, SESSION_RESTORE_DELAYS, sessionErrorKind } from "../session-restore.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test("a normal cached session restores after server validation", async () => {
  const storage = createResilientAuthStorage(memoryStorage({ "sb-project-auth-token": "saved-session" }));
  const session = { access_token: "private-token", user: { id: "user-1" } };
  const result = await restoreSessionWithRetry({
    storage, delays: [0], sleep: async () => {},
    getSession: async () => ({ data: { session }, error: null }),
    getUser: async () => ({ data: { user: session.user }, error: null })
  });
  assert.equal(result.status, "restored");
  assert.equal(result.session, session);
});

test("transient wake failures retain the cache and recover within the retry window", async () => {
  const raw = memoryStorage({ "sb-project-auth-token": "saved-session" });
  const storage = createResilientAuthStorage(raw);
  let attempt = 0;
  const result = await restoreSessionWithRetry({
    storage, delays: [0, 1000, 2000], sleep: async () => {},
    getSession: async () => ({ data: { session: { user: { id: "user-1" } } }, error: null }),
    getUser: async () => ++attempt < 3 ? ({ data: null, error: { status: 503, message: "project is waking" } }) : ({ data: { user: { id: "user-1" } }, error: null })
  });
  assert.equal(result.status, "restored");
  assert.equal(attempt, 3);
  assert.equal(raw.getItem("sb-project-auth-token"), "saved-session");
});

test("a thrown network failure is transient and the next attempt can recover", async () => {
  const storage = createResilientAuthStorage(memoryStorage({ "sb-project-auth-token": "saved-session" }));
  let calls = 0;
  const result = await restoreSessionWithRetry({
    storage, delays: [0, 1], sleep: async () => {},
    getSession: async () => { if (++calls === 1) throw new TypeError("fetch failed"); return { data: { session: { user: { id: "user-1" } } }, error: null }; },
    getUser: async () => ({ data: { user: { id: "user-1" } }, error: null })
  });
  assert.equal(result.status, "restored");
  assert.equal(calls, 2);
});

test("only confirmed invalid or revoked sessions return invalid", async () => {
  const raw = memoryStorage({ "sb-project-auth-token": "saved-session" });
  const storage = createResilientAuthStorage(raw);
  const result = await restoreSessionWithRetry({
    storage, delays: [0], sleep: async () => {},
    getSession: async () => ({ data: null, error: { status: 400, code: "refresh_token_not_found", message: "Refresh token not found" } }),
    getUser: async () => { throw new Error("should not validate user"); }
  });
  assert.equal(result.status, "invalid");
  assert.equal(sessionErrorKind({ status: 503, message: "fetch failed" }), "transient");
  storage.discard();
  assert.equal(raw.getItem("sb-project-auth-token"), null);
});

test("temporary SDK cache removal can be restored without duplicating persistence", () => {
  const raw = memoryStorage({ "sb-project-auth-token": "saved-session" });
  const storage = createResilientAuthStorage(raw);
  storage.removeItem("sb-project-auth-token");
  assert.equal(raw.getItem("sb-project-auth-token"), null);
  assert.equal(storage.restore(), true);
  assert.equal(raw.getItem("sb-project-auth-token"), "saved-session");
});

test("restore and email-code UI messaging protects session state and never remembers a code", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.equal(SESSION_RESTORE_DELAYS.reduce((sum, delay) => sum + delay, 0), 12000);
  assert.match(app, /RESTORING SESSION/);
  assert.match(app, /Waking your ledger/);
  assert.match(app, /Nothing was signed out or cleared, and local drafts remain/);
  assert.match(app, /localStorage\.setItem\(rememberedEmailKey, email\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*(?:token|code)/i);
  assert.match(app, /We’ll email a verification code you can enter here/);
  assert.match(app, /autocomplete="one-time-code"/);
  assert.match(app, /maxlength="8" pattern="\[0-9\]\{6,8\}"/);
  assert.match(app, /if \(!\/\^\\d\{6,8\}\$\/\.test\(token\)\)/);
  assert.match(app, /supabase\.auth\.verifyOtp\(\{ email, token, type: "email" \}\)/);
  assert.doesNotMatch(app, /function renderEmailLinkSent/);
  assert.doesNotMatch(app, /Email me a sign-in link/);
});
