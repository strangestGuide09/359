const invalidCodes = new Set([
  "bad_jwt", "invalid_claim", "invalid_grant", "invalid_refresh_token",
  "refresh_token_already_used", "refresh_token_not_found", "session_not_found", "user_not_found"
]);

export const SESSION_RESTORE_DELAYS = [0, 1000, 2000, 3000, 3000, 3000];

export function sessionErrorKind(error) {
  if (!error) return "none";
  const code = String(error.code || error.error_code || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();
  const status = Number(error.status || error.statusCode || 0);
  if (invalidCodes.has(code) || /refresh token (?:is )?(?:invalid|expired|missing|not found|already used)|session (?:is )?(?:invalid|expired|not found)|user not found/.test(message)) return "invalid";
  if (status === 401 && /jwt|token|session|unauthori[sz]ed/.test(`${code} ${message}`)) return "invalid";
  return "transient";
}

export function createResilientAuthStorage(storage) {
  let backupKey = "";
  let backupValue = "";
  let discarded = false;
  const isAuthKey = key => /^sb-[a-z0-9_-]+-auth-token$/i.test(String(key));
  const remember = (key, value) => {
    if (isAuthKey(key) && value) { backupKey = key; backupValue = value; discarded = false; }
  };
  for (let index = 0; index < Number(storage.length || 0); index += 1) {
    const key = storage.key?.(index);
    if (key) remember(key, storage.getItem(key));
  }
  return {
    getItem(key) { const value = storage.getItem(key); remember(key, value); return value; },
    setItem(key, value) { remember(key, value); storage.setItem(key, value); },
    removeItem(key) { const value = storage.getItem(key); remember(key, value); storage.removeItem(key); },
    hasCachedSession() { return !discarded && !!(backupValue || (backupKey && storage.getItem(backupKey))); },
    restore() {
      if (discarded || !backupKey || !backupValue || storage.getItem(backupKey)) return false;
      storage.setItem(backupKey, backupValue);
      return true;
    },
    discard() {
      discarded = true;
      if (backupKey) storage.removeItem(backupKey);
      backupKey = "";
      backupValue = "";
    }
  };
}

export async function restoreSessionWithRetry({ getSession, getUser, storage, delays = SESSION_RESTORE_DELAYS, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), onAttempt = () => {} }) {
  const startedWithCache = storage.hasCachedSession();
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await sleep(delays[attempt]);
    onAttempt(attempt);
    storage.restore();
    let sessionResult;
    try { sessionResult = await getSession(); } catch { continue; }
    if (sessionResult.error) {
      if (sessionErrorKind(sessionResult.error) === "invalid") return { status: "invalid", error: sessionResult.error };
      continue;
    }
    const session = sessionResult.data?.session;
    if (!session) {
      if (!startedWithCache && !storage.hasCachedSession()) return { status: "signed-out" };
      continue;
    }
    let userResult;
    try { userResult = await getUser(); } catch { continue; }
    if (userResult.error) {
      if (sessionErrorKind(userResult.error) === "invalid") return { status: "invalid", error: userResult.error };
      continue;
    }
    return { status: "restored", session };
  }
  return { status: "transient" };
}
