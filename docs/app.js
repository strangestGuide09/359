import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";
import { applyPresentation, readPresentation, savePresentation } from "./appearance.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";
import { classifySignInError } from "./auth-errors.js";
import { isDuplicateImportError, sameFingerprint } from "./duplicate-import.js";
import { clearImportFeedback, showImportFeedback as renderImportFeedback } from "./import-feedback.js";
import { duplicateState, restorableDuplicatePurchaseId } from "./invoice-duplicate.js";
import { previewState } from "./dashboard-view.js";
import { formatMemberName } from "./member-names.js";
import { parseReceipt } from "./receipt-parser.js";
import { canManageReceipt, receiptEditChanges } from "./receipt-actions.js";
import { forgetRemovedReceipt, readRemovedReceipt, rememberRemovedReceipt } from "./receipt-removal.js";
import { isRestockMerchandise, qualifiesForRestockSuggestion, restockEligibility, restockEmptyGuidance } from "./restock.js";
import { focusRestockReceipt } from "./restock-review.js";
import { settlementAmountError, settlementConfirmation, settlementState } from "./settlement-flow.js";
import { createResilientAuthStorage, restoreSessionWithRetry, sessionErrorKind } from "./session-restore.js";
import { hasUnsafeDraft, versionAction } from "./version-check.js";
import { AI_SANITIZER_VERSION, aiParseMessage, buildSanitizedPdf, suggestedSanitizedLines, validateSanitizedText } from "./ai-receipt-sanitizer.js";
import { aiNetworkPollDecision, aiPollDecision, aiRetryDelayMs } from "./ai-receipt-flow.js";

const authStorage = createResilientAuthStorage(window.localStorage);
const AI_IDLE_MESSAGE = "Prepare a separate redacted derivative for optional AI processing. The original PDF is never uploaded.";
const aiProcessingStatus = document.querySelector(".ai-improve small");
aiProcessingStatus.id = "ai-processing-status";
aiProcessingStatus.classList.add("ai-processing-status");
aiProcessingStatus.setAttribute("role", "status");
aiProcessingStatus.setAttribute("aria-live", "polite");
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: authStorage }
});
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const money = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(n) || 0);
const fmt = d => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d}T12:00:00`));
const fmtTimestamp = d => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(d));
const esc = text => String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const retryKey = "grocery-ledger-email-retry-at";
const rememberedEmailKey = "grocery-ledger-last-email";
const dialog = $("entry");
const aiPreviewDialog = $("ai-preview");
const clientBuild = window.GROCERY_LEDGER_BUILD || "local-dev";
const reloadVersionKey = "grocery-ledger-reloading-version";

applyPresentation(document, readPresentation(window.localStorage));
document.querySelectorAll('input[name="presentation"]').forEach(input => input.addEventListener("change", () => {
  if (!input.checked) return;
  applyPresentation(document, savePresentation(window.localStorage, input.value));
  note(`${input.value === "sketch" ? "Sketch" : "Classic"} presentation selected.`);
}));

let session;
let current;
let members = [];
let ledger = { purchases: [], settlements: [], archivedPurchases: [], archivedSettlements: [] };
let channel;
let mode = "expense";
let pendingPdfImport;
let editingPurchase;
let reviewedItems = [];
let lastPdfFeedback;
let formDirty = false;
let explicitSignOut = false;
let restorePromise;
let verifyingOtp = false;

document.addEventListener("input", event => { if (event.target.closest?.("form")) formDirty = true; });
document.addEventListener("change", event => { if (event.target.closest?.("form")) formDirty = true; });

function note(text) { $("status").textContent = text || ""; }
function showImportFeedback(message, kind = "info", options) { return renderImportFeedback(document, message, kind, options); }
function duplicatePurchase(result) {
  if (!result?.purchase_id) return undefined;
  return [...ledger.purchases, ...ledger.archivedPurchases].find(purchase => purchase.id === result.purchase_id);
}
function duplicateImportMessage(result) {
  const status = duplicateState(result);
  const existing = duplicatePurchase(result);
  const identity = existing ? ` as ${existing.label} from ${fmt(existing.purchased_on)}` : "";
  if (status === "linked_archived_restorable") return `This receipt was already imported${identity} and later removed. Restore it instead of importing another copy.`;
  if (status === "linked_archived_not_authorized") return "This receipt was already imported and later removed. Only its payer or the household owner can restore it.";
  if (status === "linked_active") return `This receipt was already imported${identity}. No new expense was added.`;
  if (status === "legacy_unlinked") return "This receipt matches an earlier import, but its original ledger entry cannot be linked safely. No new expense was added.";
  return "This receipt matches more than one earlier import and cannot be linked safely. No new expense was added.";
}
async function findInvoiceDuplicate(fingerprint) {
  const { data, error } = await supabase.rpc("find_invoice_duplicate", { p_household_id: current.id, p_exact_pdf_hash: fingerprint.exactHash, p_content_hash: fingerprint.contentHash });
  return { result: Array.isArray(data) ? data[0] : data, error };
}
function showDuplicateImport(result, fingerprint) {
  const existing = duplicatePurchase(result);
  const message = duplicateImportMessage(result);
  lastPdfFeedback = { exactHash: fingerprint?.exactHash, contentHash: fingerprint?.contentHash, message, result };
  const restoreId = restorableDuplicatePurchaseId(result);
  return showImportFeedback(message, "duplicate", restoreId ? { durationMs: 0, action: { label: "Restore removed receipt", ariaLabel: `Restore ${existing?.label || "removed receipt"} to the ledger`, onClick: async event => { event.currentTarget.disabled = true; if (!await restoreRemovedReceipt(restoreId, "duplicate")) event.currentTarget.disabled = false; } } } : undefined);
}
function inviteCodeFromUrl() {
  const code = new URLSearchParams(location.search).get("invite")?.trim() || "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(code) ? code : "";
}
function clearInviteFromUrl() {
  const url = new URL(location.href);
  url.searchParams.delete("invite");
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}
function active() { return current && !current.archived_at; }
function isOwner() { return current?.role === "owner"; }
function hasPartner() { return members.length === 2; }
function partner() { return members.find(member => member.user_id !== session?.user?.id); }
function accountDisplayName() { return String(session?.user?.user_metadata?.display_name || "").trim(); }
function needsDisplayName(member) {
  const name = String(member?.display_name || "").trim();
  return !name || /^Household (?:owner|partner)$/i.test(name);
}
function memberDisplayName(member) {
  const name = String(member?.display_name || "").trim();
  return name || (member?.role === "owner" ? "Owner" : "Partner");
}
function displayedMemberName(member) { return formatMemberName(memberDisplayName(member)); }
function memberName(id) {
  const member = members.find(candidate => candidate.user_id === id);
  const name = displayedMemberName(member);
  return id === session?.user?.id ? `${name} (you)` : name;
}
function payerName(member) {
  const role = member.role === "owner" ? "Owner" : "Partner";
  return `${displayedMemberName(member)} (${member.user_id === session?.user?.id ? "you · " : ""}${role})`;
}
function populatePayers(selectedId = session?.user?.id) {
  const choices = [...members].sort((a, b) => (a.role === "owner" ? -1 : 1) - (b.role === "owner" ? -1 : 1));
  $("paid-by").innerHTML = choices.map(member => `<option value="${member.user_id}">${esc(payerName(member))}</option>`).join("");
  $("paid-by").value = choices.some(member => member.user_id === selectedId) ? selectedId : session?.user?.id || "";
}
function setScreen(html, { busy = false, focus = true } = {}) {
  const screen = $("screen");
  formDirty = false;
  screen.innerHTML = html;
  const main = document.querySelector("main");
  if (screen.querySelector(".dashboard-shell")) main.dataset.layout = "dashboard";
  else if (screen.querySelector(".household-gate")) main.dataset.layout = "household-gate";
  else if (screen.querySelector(".partner-gate")) main.dataset.layout = "partner-gate";
  else main.dataset.layout = "narrow";
  screen.setAttribute("aria-busy", String(busy));
  if (focus) requestAnimationFrame(() => screen.querySelector("h1,h2")?.focus({ preventScroll: true }));
}
function statePanel(kicker, title, body, action = "") {
  return `<section class="panel state-panel"><p>${kicker}</p><h1 tabindex="-1">${title}</h1><article>${body}</article>${action}</section>`;
}
function renderLoading(message = "Opening your household ledger…") {
  $("sync-state").textContent = "Loading…";
  setScreen(statePanel("PLEASE WAIT", "Opening Grocery Ledger", `<span class="spinner" aria-hidden="true"></span>${esc(message)}`), { busy: true });
  note("");
}
function renderRestoring(attempt = 0) {
  $("sync-state").textContent = "Restoring session…";
  const detail = attempt ? "The secure connection is taking a little longer. Your saved session and local drafts are still here." : "Your saved session is still on this browser. Waking the ledger and reconnecting securely…";
  setScreen(statePanel("RESTORING SESSION", "Waking your ledger", `<span class="spinner" aria-hidden="true"></span>${detail}`), { busy: true });
  note("");
}
function renderRestoreRetry() {
  $("sync-state").textContent = "Still reconnecting";
  setScreen(statePanel("CONNECTION PROBLEM", "Your session is still saved", "The ledger did not wake within a few seconds. Nothing was signed out or cleared, and local drafts remain in this browser.", '<button id="retry-session">Try restoring again</button>'));
  $("retry-session").onclick = restoreSavedSession;
}
function confirmedInvalidSession() {
  authStorage.discard();
  clearSignedInState();
  renderSignedOut("signin", "Your saved session has expired or was revoked. Sign in again to continue.");
}
async function runSessionRestore() {
  const result = await restoreSessionWithRetry({
    getSession: () => supabase.auth.getSession(),
    getUser: () => supabase.auth.getUser(),
    storage: authStorage,
    onAttempt: renderRestoring
  });
  if (result.status === "invalid") return confirmedInvalidSession();
  if (result.status === "signed-out") return renderSignedOut();
  if (result.status === "transient") return renderRestoreRetry();
  session = result.session;
  explicitSignOut = false;
  return loadHousehold();
}
function restoreSavedSession() {
  if (!restorePromise) restorePromise = runSessionRestore().finally(() => { restorePromise = undefined; });
  return restorePromise;
}
function renderLoadError(title, detail, retry) {
  $("sync-state").textContent = "Could not sync";
  setScreen(statePanel("CONNECTION PROBLEM", esc(title), `${esc(detail)} Your balance is hidden until current ledger data loads.`, `<button id="retry-load">Try again</button>`));
  $("retry-load").onclick = retry;
}
function clearSignedInState() {
  session = undefined;
  current = undefined;
  members = [];
  ledger = { purchases: [], settlements: [], archivedPurchases: [], archivedSettlements: [] };
  channel?.unsubscribe();
}
async function signOutSafely() {
  explicitSignOut = true;
  const { error } = await supabase.auth.signOut();
  if (error) {
    explicitSignOut = false;
    authStorage.restore();
    note("Could not sign out while the connection is unavailable. Try again when the ledger reconnects.");
    restoreSavedSession();
    return;
  }
  authStorage.discard();
  clearSignedInState();
  renderSignedOut();
}
function roleName() { return isOwner() ? "Owner" : "Partner"; }
function sharedPurchaseAmount(purchase) {
  const items = purchase.purchase_items || [];
  if (!items.length) return purchase.is_personal ? 0 : Number(purchase.amount);
  return items.reduce((total, item) => total + (item.is_personal ? 0 : Number(item.line_total) || 0), 0);
}
function balanceFor(userId) {
  if (!hasPartner()) return 0;
  let total = 0;
  for (const purchase of ledger.purchases) {
    const sharedAmount = sharedPurchaseAmount(purchase);
    total += purchase.paid_by === userId ? sharedAmount / 2 : -sharedAmount / 2;
  }
  for (const settlement of ledger.settlements) total += settlement.payer === userId ? Number(settlement.amount) : settlement.receiver === userId ? -Number(settlement.amount) : 0;
  return total;
}
function row(item, type) {
  const own = type === "purchase" ? item.paid_by === session.user.id : item.payer === session.user.id;
  const canManage = type === "purchase" ? canManageReceipt(item, session.user.id, isOwner(), active()) : own || isOwner();
  const heading = type === "purchase" ? esc(item.label) : `${esc(memberName(item.payer))} paid ${esc(memberName(item.receiver))}`;
  if (type === "purchase") {
    const itemCount = item.purchase_items?.length || 0;
    const receiptActions = canManage && active() ? `<div class="receipt-action-buttons" data-label="Actions" role="group" aria-label="Receipt actions for ${heading}"><button type="button" class="receipt-edit" data-edit-receipt="${item.id}" aria-label="Edit receipt for ${heading}"><svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="m4 20 4.2-1 10.7-10.7a2.1 2.1 0 0 0-3-3L5.2 16 4 20Zm10.7-13.7 3 3"/></svg><span>Edit</span></button><button type="button" class="receipt-delete" data-delete-receipt="${item.id}" aria-label="Remove ${heading} from the ledger"><svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg><span>Remove</span></button></div>` : `<span class="receipt-actions-empty" aria-hidden="true"></span>`;
    return `<div class="expense purchase-row" data-purchase-id="${item.id}"><div class="purchase-merchant"><b>${heading}</b><span>${esc(item.category)}${item.is_personal ? " · personal" : ""}</span></div><span data-label="Paid by">${esc(memberName(item.paid_by))}</span><time data-label="Date">${fmt(item.purchased_on)}</time><span data-label="Items">${itemCount ? `${itemCount} reviewed` : "Manual entry"}</span><div class="purchase-amount" data-label="Amount"><b>${money(item.amount)}</b></div>${receiptActions}</div>`;
  }
  return `<div class="expense"><div><b>${heading}</b><span>${fmt(item.settled_on)}</span></div><div class="entry-actions"><b>${money(item.amount)}</b>${canManage && active() ? `<button class="plain action" data-archive="${type}" data-id="${item.id}">Archive</button>` : ""}</div></div>`;
}
function suggestionCards() {
  const { groups, stats } = restockEligibility(ledger.purchases);
  const cards = [...groups.values()].map(items => {
    items.sort((a, b) => a.purchased_on.localeCompare(b.purchased_on));
    const dates = [...new Set(items.map(item => item.purchased_on))];
    if (!qualifiesForRestockSuggestion(items)) return null;
    const [previous, last] = dates.slice(-2);
    const days = Math.max(1, Math.round((Date.parse(`${last}T12:00:00`) - Date.parse(`${previous}T12:00:00`)) / 86400000));
    const latest = items.at(-1);
    const due = latest.estimated_use_by || new Date(Date.parse(`${last}T12:00:00`) + days * 86400000).toISOString().slice(0, 10);
    const timing = due <= today() && latest.purchase_id
      ? `<button type="button" class="restock-review" data-review-restock="${latest.purchase_id}" data-review-name="${esc(latest.display_name)}" aria-label="Review ${esc(latest.display_name)} in its latest receipt">Review now</button>`
      : `<time class="restock-timing${due <= today() ? " due" : ""}" datetime="${due}">${due <= today() ? "Review due" : `Around ${fmt(due)}`}</time>`;
    return `<div class="suggestion"><div><b>${esc(latest.display_name)}</b><span>${latest.estimated_use_by ? "Reviewed use-by" : `Latest interval: ${days} days`} · bought ${dates.length} times</span></div>${timing}</div>`;
  }).filter(Boolean);
  const guidance = restockEmptyGuidance(groups, stats);
  return {
    cards,
    empty: `<div class="restock-empty"><b>${esc(guidance.title)}</b><p>${esc(guidance.next)}</p><details><summary>Why nothing is showing yet</summary><p>${esc(guidance.detail)}</p></details></div>`
  };
}

function renderOtpChallenge(email, creating) {
  $("sync-state").textContent = "Check your email";
  setScreen('<section class="panel account-gate"><p>CHECK YOUR EMAIL</p><h1 tabindex="-1">Enter your verification code</h1><article>Enter the verification code sent to <b>' + esc(email) + '</b>. It works here without leaving Grocery Ledger.</article><form id="otp-form" class="auth-form"><label>Verification code<input id="login-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]{6,8}" required placeholder="12345678"></label><button>Verify code</button></form><button id="send-another-code" type="button" class="plain">Use another email or send another code</button><p id="auth-status" class="auth-status" role="status"></p></section>');
  $("send-another-code").onclick = () => renderSignedOut(creating ? "signup" : "signin");
  $("otp-form").onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    const input = $("login-code");
    const token = input.value.trim();
    if (!/^\d{6,8}$/.test(token)) {
      $("auth-status").className = "auth-status error";
      $("auth-status").textContent = "Enter the 6–8 digit code from your email.";
      input.focus();
      return;
    }
    button.disabled = true;
    button.textContent = "Verifying…";
    verifyingOtp = true;
    try {
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
      input.value = "";
      if (error || !data?.session) {
        $("auth-status").className = "auth-status error";
        $("auth-status").textContent = error && sessionErrorKind(error) === "invalid"
          ? "That verification code is invalid or expired. Send another code and try again."
          : "We couldn’t verify the code. Send another code and try again.";
        button.disabled = false;
        button.textContent = "Try verification again";
        return;
      }
      session = data.session;
      renderRestoring();
      await loadHousehold();
    } catch {
      $("auth-status").className = "auth-status error";
      $("auth-status").textContent = "We couldn’t verify the code. Try again in a moment.";
      button.disabled = false;
      button.textContent = "Try verification again";
    } finally {
      verifyingOtp = false;
    }
  };
}

function renderSignedOut(authMode = "signin", statusMessage = "") {
  $("sync-state").textContent = "Sign in required";
  const creating = authMode === "signup";
  const rememberedEmail = localStorage.getItem(rememberedEmailKey) || "";
  const retryAt = Number(localStorage.getItem(retryKey) || 0);
  const waiting = retryAt > Date.now();
  const time = new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  setScreen(`<section class="panel account-gate"><p>WELCOME</p><h1 tabindex="-1">Grocery Ledger</h1><article>${creating ? "Create your account with your name and email." : "Sign in to your existing account."} We’ll email a verification code you can enter here.</article><div class="auth-choice" aria-label="Account access"><button id="show-signin" type="button" class="${creating ? "secondary" : ""}" aria-pressed="${!creating}">Sign in</button><button id="show-signup" type="button" class="${creating ? "" : "secondary"}" aria-pressed="${creating}">Create account</button></div><form id="login-form" class="auth-form${creating ? " auth-signup" : ""}">${creating ? '<label>Your name<input id="signup-name" maxlength="80" required autocomplete="name" placeholder="e.g. Ekta"></label>' : ""}<label>Email<input id="login-email" type="email" required autocomplete="email" value="${esc(rememberedEmail)}" placeholder="you@example.com"></label><button${waiting ? " disabled" : ""}>${waiting ? `Try again at ${time}` : creating ? "Create account and send code" : "Send verification code"}</button></form><p id="auth-status" class="auth-status${waiting || statusMessage ? " error" : ""}">${esc(statusMessage || (waiting ? `Try again at ${time}.` : creating ? "Your name is shared only with your household partner." : "Sign in will not create a new account."))}</p></section>`);
  $("show-signin").onclick = () => renderSignedOut("signin");
  $("show-signup").onclick = () => renderSignedOut("signup");
  $("login-form").onsubmit = async event => {
    event.preventDefault();
    if (waiting) return;
    const button = $("login-form").querySelector("button");
    const email = $("login-email").value.trim();
    const displayName = creating ? $("signup-name").value.trim() : "";
    button.disabled = true;
    button.textContent = "Sending…";
    const options = { shouldCreateUser: creating };
    if (creating) options.data = { display_name: displayName };
    localStorage.setItem(rememberedEmailKey, email);
    const { error } = await supabase.auth.signInWithOtp({ email, options });
    if (error) {
      const diagnostic = classifySignInError(error);
      if (diagnostic.kind === "rate_limit") {
        localStorage.setItem(retryKey, Date.now() + 3600000);
        return renderSignedOut(authMode);
      }
      $("auth-status").className = "auth-status error";
      $("auth-status").textContent = diagnostic.message;
      button.disabled = false;
      button.textContent = "Try again";
      return;
    }
    renderOtpChallenge(email, creating);
  };
}
function renderHouseholdSetup() {
  $("sync-state").textContent = "Signed in";
  const invited = inviteCodeFromUrl();
  const knownName = accountDisplayName();
  const nameField = knownName ? `<p class="setup-name">Continue as <b>${esc(knownName)}</b></p>` : '<label>Your name<input id="setup-display-name" maxlength="80" required autocomplete="name" placeholder="e.g. Ekta"></label>';
  const setupName = () => knownName || $("setup-display-name")?.value.trim() || "";
  setScreen(`<section class="panel account-gate household-gate"><p>ACCOUNT SETUP</p><h1 tabindex="-1">${invited ? "Join your partner’s household" : "Start your two-person ledger"}</h1><article>${invited ? "Your invite link is ready. Confirm the code below to join the shared ledger." : "Create your household, or join your partner with their invite code."}</article>${nameField}<div class="two action-grid"><form id="create-form"><h2>Create household</h2><label>Household name<input id="household-name" maxlength="80" required placeholder="e.g. Ekta & Ritesh"></label><button>Create household</button></form><form id="join-form"><h2>Join your partner</h2><label>Invite code<input id="invite-code" required value="${esc(invited)}" placeholder="Paste invite code"></label><button class="secondary">Join household</button></form></div><button id="sign-out" class="plain">Sign out</button></section>`);
  $("create-form").onsubmit = async event => {
    event.preventDefault();
    if (!setupName()) { note("Add your name before continuing."); $("setup-display-name")?.focus(); return; }
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    button.textContent = "Creating…";
    const { error } = await supabase.rpc("create_household", { household_name: $("household-name").value.trim(), p_display_name: setupName() });
    if (error) { note(error.message); button.disabled = false; button.textContent = "Create household"; return; }
    await loadHousehold();
  };
  $("join-form").onsubmit = async event => {
    event.preventDefault();
    if (!setupName()) { note("Add your name before continuing."); $("setup-display-name")?.focus(); return; }
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    button.textContent = "Joining…";
    const { error } = await supabase.rpc("join_household", { code: $("invite-code").value.trim(), p_display_name: setupName() });
    if (error) { note(error.message); button.disabled = false; button.textContent = "Join household"; return; }
    clearInviteFromUrl();
    await loadHousehold();
  };
  $("sign-out").onclick = signOutSafely;
}
function renderDisplayNameGate(member) {
  $("sync-state").textContent = "Name required";
  setScreen(`<section class="panel account-gate"><p>ONE-TIME UPDATE</p><h1 tabindex="-1">How should your partner see you?</h1><article>Add your real name once. You can change it later in Settings.</article><form id="missing-name-form" class="name-form"><label>Your name<input id="missing-name" maxlength="80" required autocomplete="name" value="${needsDisplayName(member) ? "" : esc(memberDisplayName(member))}" placeholder="e.g. Ritesh"></label><button>Save and continue</button></form><button id="sign-out" class="plain">Sign out</button></section>`);
  $("missing-name-form").onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    const { error } = await supabase.rpc("set_my_display_name", { p_display_name: $("missing-name").value.trim() });
    if (error) { note(error.message); button.disabled = false; return; }
    await loadLedger();
  };
  $("sign-out").onclick = signOutSafely;
}
function renderPartnerInvite() {
  $("sync-state").textContent = "Waiting for partner";
  setScreen(`<section class="panel account-gate partner-gate"><p>HOUSEHOLD CREATED</p><h1 tabindex="-1">Invite your partner</h1><article>${esc(current.name)} becomes a shared ledger after your partner joins. Shared expenses, balances, settlements, and restock history stay locked until then.</article><div class="invite-box"><h2>Send a one-time invite</h2><p>Create a new invite link, then send it privately to your partner. They can also paste the code shown in the link.</p><div class="settings-actions"><button id="copy-invite">Copy invite link</button><button id="email-invite" class="secondary">Email invite</button></div></div><div class="settings-actions"><button id="add-personal" class="secondary">Add personal expense</button><button id="refresh-partner" class="plain">Check if partner joined</button><button id="sign-out" class="plain">Sign out</button></div></section>`);
  $("copy-invite").onclick = () => shareInvite("copy");
  $("email-invite").onclick = () => shareInvite("email");
  $("add-personal").onclick = () => openEntry("expense", { personal: true });
  $("refresh-partner").onclick = loadLedger;
  $("sign-out").onclick = signOutSafely;
}
async function issueInvite() {
  const { data, error } = await supabase.rpc("create_household_invite", { p_household_id: current.id });
  if (error) { note(error.message); return null; }
  return data;
}
async function shareInvite(kind) {
  const code = await issueInvite();
  if (!code) return;
  const inviteUrl = `${location.origin}${location.pathname}?invite=${encodeURIComponent(code)}`;
  const body = `Open this private Grocery Ledger invite link, sign in, and confirm the invite code to join my household:\n\n${inviteUrl}`;
  if (kind === "email") location.href = `mailto:?subject=${encodeURIComponent("Join my Grocery Ledger household")}&body=${encodeURIComponent(body)}`;
  else try { await navigator.clipboard.writeText(inviteUrl); note("New invite link copied."); } catch { note(`Copy is unavailable. Invite code: ${code}`); }
}
function renderMembers() {
  return members.map(member => `<span class="member-block"><strong>${esc(displayedMemberName(member))}</strong><span aria-hidden="true">·</span><span>${member.role === "owner" ? "owner" : "partner"}</span>${member.user_id === session.user.id ? '<span aria-hidden="true">·</span><small class="you-badge">you</small>' : ""}</span>`).join("");
}
function renderPreview(rows, { id, limit, noun, empty }) {
  if (!rows.length) return empty;
  const state = previewState(rows.length, limit);
  const items = rows.map((content, index) => `<div class="preview-row"${index >= state.visibleCount ? ` data-preview-extra="${id}" hidden` : ""}>${content}</div>`).join("");
  const controls = state.hasToggle ? `<div class="preview-controls"><span data-preview-count="${id}">${state.summary}</span><button type="button" class="plain preview-toggle" data-preview="${id}" data-total="${rows.length}" data-noun="${noun}" aria-controls="${id}" aria-expanded="false">Review all ${rows.length}</button></div>` : "";
  return `<div id="${id}">${items}</div>${controls}`;
}
function renderBalance(balance, archived) {
  const otherName = displayedMemberName(partner());
  const currentName = displayedMemberName(members.find(member => member.user_id === session.user.id));
  const balanceText = Math.abs(balance) < .005 ? `You and ${esc(otherName)} are settled` : balance > 0 ? `${esc(otherName)} owes you ${money(balance)}` : `You owe ${esc(otherName)} ${money(-balance)}`;
  const settlement = settlementState(balance, currentName, otherName);
  const guidance = settlement.kind === "settled" ? "" : `<div class="balance-next"><b>Next step</b><span>${esc(settlement.guidance)}</span>${settlement.actionLabel ? `<button id="settle">${esc(settlement.actionLabel)} · ${money(settlement.amount)}</button>` : ""}</div>`;
  return `<section class="balance-card" aria-labelledby="balance-title"><small id="balance-title">Current balance</small><strong>${balanceText}</strong><span>Shared items split equally</span>${archived ? "" : guidance}</section>`;
}
function renderSettings(balance, archived, recoveryOpen) {
  const ownerControls = isOwner() ? archived ? `<div class="danger-zone">${recoveryOpen ? `<button id="restore-household" class="secondary">Restore household</button><small>Recovery is available until ${fmt(current.purge_after)}.</small>` : `<button id="delete-household" class="danger">Permanently delete</button><small>The 30-day recovery period has ended.</small>`}</div>` : `<div class="danger-zone"><b>Close household</b><small>${Math.abs(balance) >= .005 ? "Settle the balance before closing." : "Starts a 30-day recovery period."}</small><button id="archive-household" class="danger"${Math.abs(balance) >= .005 ? " disabled" : ""}>Close household</button></div>` : "";
  const archivedEntries = [...ledger.archivedPurchases.map(item => ({ ...item, type: "purchase" })), ...ledger.archivedSettlements.map(item => ({ ...item, type: "settlement" }))];
  const memberRows = members.map(member => `<div class="expense"><div><b>${esc(displayedMemberName(member))}</b><span>${member.role === "owner" ? "Owner" : "Partner"}${member.user_id === session.user.id ? " · you" : ""}</span></div></div>`).join("");
  const nameForm = archived ? "" : `<form id="display-name-form" class="inline-form"><label>Your display name<input id="display-name" maxlength="80" required autocomplete="name" value="${esc(memberDisplayName(members.find(member => member.user_id === session.user.id)))}"></label><button class="secondary">Update name</button></form>`;
  const archiveList = archivedEntries.length ? `<details class="archive-list"><summary>Removed receipts & archived settlements (${archivedEntries.length})</summary>${archivedEntries.map(item => `<div class="expense"><div><b>${item.type === "purchase" ? `Removed receipt: ${esc(item.label)}` : "Archived settlement"}</b><span>${money(item.amount)} · ${item.type === "purchase" ? `Removed ${fmtTimestamp(item.archived_at)}${item.archived_by ? ` by ${esc(memberName(item.archived_by))}` : ""}` : `Archived ${fmtTimestamp(item.archived_at)}`}</span></div>${active() && (isOwner() || (item.type === "purchase" ? item.paid_by : item.payer) === session.user.id) ? `<button class="secondary" data-restore-entry="${item.type}" data-id="${item.id}">${item.type === "purchase" ? "Restore to ledger" : "Restore settlement"}</button>` : ""}</div>`).join("")}</details>` : "";
  const accountSession = `<section class="account-session" aria-labelledby="account-session-title"><div><b id="account-session-title">Account and session</b><small>Sign out of Grocery Ledger on this browser.</small></div><button id="sign-out" class="secondary session-sign-out">Sign out</button></section>`;
  return `<details id="household-settings" class="panel settings"><summary><span><b>Household settings</b><small>Names, removed receipts and recovery</small></span><span aria-hidden="true">Open</span></summary><div class="settings-body"><section class="settings-profile" aria-labelledby="settings-members-title"><div class="settings-section-heading"><b id="settings-members-title">Household members</b><small>Two people share this ledger.</small></div><div class="member-list">${memberRows}</div>${nameForm}</section><section class="settings-account" aria-label="Account and recovery">${accountSession}${archiveList}</section>${ownerControls}</div></details>`;
}
function renderRemovalUndo() {
  const purchase = readRemovedReceipt(sessionStorage, current.id, session.user.id, ledger.archivedPurchases);
  if (!purchase || !canManageReceipt(purchase, session.user.id, isOwner(), active())) return "";
  return `<section class="removal-undo" role="status" aria-live="polite"><span><b>${esc(purchase.label)} was removed from the ledger.</b><small>It no longer affects balances or Possible Buys and remains restorable.</small></span><button id="undo-receipt-removal" type="button" class="secondary" data-receipt-id="${purchase.id}">Undo</button></section>`;
}
function renderDashboard() {
  const balance = balanceFor(session.user.id);
  const archived = !!current.archived_at;
  const recoveryOpen = archived && new Date(current.purge_after) > new Date();
  $("sync-state").textContent = archived ? "Archived · read only" : "Synced";
  const purchases = [...ledger.purchases].sort((a, b) => b.purchased_on.localeCompare(a.purchased_on)).map(item => row(item, "purchase")).join("") || '<p class="empty-state">No shared expenses yet. Add one or import a receipt to begin.</p>';
  const settlementRows = [...ledger.settlements].sort((a, b) => b.settled_on.localeCompare(a.settled_on)).map(item => row(item, "settlement"));
  const restock = suggestionCards();
  const restockPanel = renderPreview(restock.cards, { id: "restock-preview", limit: 4, noun: "suggestions", empty: restock.empty });
  const settlementPanel = renderPreview(settlementRows, { id: "settlement-preview", limit: 3, noun: "settlements", empty: '<p class="empty-state">No settlements recorded.</p>' });
  const actions = archived ? "" : `<nav class="command-actions primary-actions" aria-label="Ledger actions"><button id="import-pdf">Import receipt</button><button id="add" class="secondary">Add expense</button><button id="open-settings" class="plain" aria-controls="household-settings">Household settings</button></nav>`;
  const archiveBanner = archived ? `<p class="archive-banner">This household is archived and read-only. ${recoveryOpen ? `It can be restored until ${fmt(current.purge_after)}.` : "Its recovery period has ended."}</p>` : "";
  setScreen(`<section class="dashboard-shell"><section class="household-masthead"><div class="household-title"><p>HOUSEHOLD</p><h1 tabindex="-1">${esc(current.name)}</h1></div><div class="member-blocks" aria-label="Household members">${renderMembers()}</div></section>${archiveBanner}<section class="command-bar">${renderBalance(balance, archived)}${actions}</section>${renderRemovalUndo()}<section class="insights-grid"><section class="panel insight-card restock-panel"><div class="heading"><div><p>RESTOCK</p><h2>Possible buys</h2></div></div>${restockPanel}</section><section class="panel insight-card settlements-panel"><div class="heading"><div><p>SETTLEMENTS</p><h2>Payment history</h2></div></div>${settlementPanel}</section></section><section class="panel expenses-panel"><div class="heading"><div><p>LEDGER</p><h2>Recent expenses</h2></div><span>${ledger.purchases.length} saved</span></div><div class="ledger-columns" aria-hidden="true"><span>Merchant</span><span>Paid by</span><span>Date</span><span>Reviewed items</span><span>Amount</span><span>Actions</span></div><div>${purchases}</div></section>${renderSettings(balance, archived, recoveryOpen)}</section>`);
  bindDashboard(balance);
}
function bindDashboard(balance) {
  $("add") && ($("add").onclick = () => openEntry("expense"));
  $("settle") && ($("settle").onclick = () => openEntry("settlement", { amount: (-balance).toFixed(2) }));
  $("import-pdf") && ($("import-pdf").onclick = () => $("pdf-file").click());
  $("open-settings") && ($("open-settings").onclick = () => {
    const settings = $("household-settings");
    settings.open = true;
    settings.querySelector("summary").focus();
    settings.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelectorAll("[data-preview]").forEach(button => button.onclick = () => {
    const id = button.dataset.preview;
    const expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    document.querySelectorAll(`[data-preview-extra="${id}"]`).forEach(item => { item.hidden = !expanded; });
    const count = document.querySelector(`[data-preview-count="${id}"]`);
    if (count) count.textContent = expanded ? "" : `Showing ${id === "restock-preview" ? 4 : 3} of ${button.dataset.total}`;
    button.textContent = expanded ? "Show fewer" : `Review all ${button.dataset.total}`;
  });
  $("sign-out").onclick = signOutSafely;
  $("display-name-form") && ($("display-name-form").onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    const { error } = await supabase.rpc("set_my_display_name", { p_display_name: $("display-name").value.trim() });
    if (error) { note(error.message); button.disabled = false; return; }
    note("Display name updated.");
    await loadLedger();
  });
  $("archive-household") && ($("archive-household").onclick = async () => { if (confirm("Close this household? It becomes read-only and can be restored for 30 days.")) await rpcReload("archive_household", { p_household_id: current.id }, "Household closed."); });
  $("restore-household") && ($("restore-household").onclick = () => rpcReload("restore_household", { p_household_id: current.id }, "Household restored."));
  $("delete-household") && ($("delete-household").onclick = async () => { if (confirm("Permanently delete this household and its reviewed ledger data? This cannot be undone.")) await rpcReload("permanently_delete_household", { p_household_id: current.id }, "Household permanently deleted."); });
  document.querySelectorAll("[data-archive]").forEach(button => button.onclick = () => archiveEntry(button.dataset.archive, button.dataset.id));
  document.querySelectorAll("[data-review-restock]").forEach(button => button.onclick = () => {
    if (focusRestockReceipt(document, button.dataset.reviewRestock)) note(`Reviewing the latest receipt containing ${button.dataset.reviewName}.`);
    else note("That receipt is no longer in the active ledger. Refresh Possible buys and try again.");
  });
  document.querySelectorAll("[data-edit-receipt]").forEach(button => button.onclick = () => editReceipt(button.dataset.editReceipt));
  document.querySelectorAll("[data-delete-receipt]").forEach(button => button.onclick = () => deleteReceipt(button.dataset.deleteReceipt));
  document.querySelectorAll("[data-restore-entry]").forEach(button => button.onclick = () => restoreEntry(button.dataset.restoreEntry, button.dataset.id));
  $("undo-receipt-removal") && ($("undo-receipt-removal").onclick = event => restoreRemovedReceipt(event.currentTarget.dataset.receiptId, "undo"));
}
async function rpcReload(name, args, success) {
  const { error } = await supabase.rpc(name, args);
  note(error ? error.message : success);
  if (!error) await loadHousehold();
}
async function loadHousehold() {
  if (!session) return renderSignedOut();
  renderLoading("Loading your household…");
  const { data: memberships, error } = await supabase.from("household_members").select("household_id,role").eq("user_id", session.user.id);
  if (error) return renderLoadError("We couldn’t load your household.", error.message, loadHousehold);
  if (!memberships.length) { current = undefined; return renderHouseholdSetup(); }
  const membership = memberships[0];
  const { data: household, error: householdError } = await supabase.from("households").select("id,name,archived_at,purge_after").eq("id", membership.household_id).maybeSingle();
  if (householdError || !household) return renderLoadError("We couldn’t open your household.", householdError?.message || "Household not found.", loadHousehold);
  current = { ...household, role: membership.role };
  await loadLedger();
}
async function loadLedger() {
  if (!current) return loadHousehold();
  renderLoading("Syncing reviewed expenses and items…");
  const [memberResult, purchaseResult, settlementResult, archivedPurchaseResult, archivedSettlementResult] = await Promise.all([
    supabase.from("household_members").select("user_id,role,display_name").eq("household_id", current.id),
    supabase.from("purchases").select("*,purchase_items(*)").eq("household_id", current.id).is("archived_at", null),
    supabase.from("settlements").select("*").eq("household_id", current.id).is("archived_at", null),
    supabase.from("purchases").select("*,purchase_items(*)").eq("household_id", current.id).not("archived_at", "is", null),
    supabase.from("settlements").select("*").eq("household_id", current.id).not("archived_at", "is", null)
  ]);
  const error = memberResult.error || purchaseResult.error || settlementResult.error || archivedPurchaseResult.error || archivedSettlementResult.error;
  if (error) return renderLoadError("We couldn’t load the current ledger.", error.message, loadLedger);
  members = memberResult.data;
  ledger = { purchases: purchaseResult.data, settlements: settlementResult.data, archivedPurchases: archivedPurchaseResult.data, archivedSettlements: archivedSettlementResult.data };
  const self = members.find(member => member.user_id === session.user.id);
  if (!current.archived_at && needsDisplayName(self)) renderDisplayNameGate(self);
  else if (members.length < 2 && !current.archived_at) renderPartnerInvite();
  else renderDashboard();
  channel?.unsubscribe();
  channel = supabase.channel(`household-${current.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "purchases", filter: `household_id=eq.${current.id}` }, loadLedger)
    .on("postgres_changes", { event: "*", schema: "public", table: "settlements", filter: `household_id=eq.${current.id}` }, loadLedger)
    .on("postgres_changes", { event: "*", schema: "public", table: "household_members", filter: `household_id=eq.${current.id}` }, loadLedger)
    .on("postgres_changes", { event: "*", schema: "public", table: "purchase_items" }, loadLedger)
    .subscribe(status => { if (["CHANNEL_ERROR", "TIMED_OUT"].includes(status)) $("sync-state").textContent = "Reconnecting…"; });
}

function emptyReviewedItem(values = {}) {
  const personal = !!values.is_personal;
  const merchandise = isRestockMerchandise(values.name);
  return { name: values.name || "", quantity: values.quantity ?? 1, unit: values.unit || "", unit_price: values.unit_price ?? null, line_total: values.line_total ?? null, is_personal: personal, is_tracked_for_restock: personal || !merchandise ? false : values.is_tracked_for_restock ?? true, estimated_use_by: values.estimated_use_by || "" };
}
function renderItemRows() {
  $("item-rows").innerHTML = reviewedItems.map((item, index) => { const restockAllowed = !item.is_personal && isRestockMerchandise(item.name); return `<fieldset class="item-row" data-item="${index}"><legend>Item ${index + 1}</legend><div class="item-primary"><label class="item-name">Item name<input data-field="name" maxlength="160" value="${esc(item.name)}" required></label><label>Qty<input data-field="quantity" inputmode="decimal" value="${item.quantity ?? ""}" placeholder="1"></label><label>Line total (₹)<input data-field="line_total" inputmode="decimal" value="${item.line_total ?? ""}" placeholder="0.00"></label></div><div class="item-flags"><label class="check"><input data-field="is_personal" type="checkbox"${item.is_personal ? " checked" : ""}> Personal</label><label class="check"><input data-field="is_tracked_for_restock" type="checkbox"${item.is_tracked_for_restock && restockAllowed ? " checked" : ""}${restockAllowed ? "" : " disabled"}> Track for restock</label><details class="item-details"><summary>More details</summary><div><label>Unit<input data-field="unit" maxlength="30" value="${esc(item.unit)}" placeholder="e.g. kg"></label><label>Unit price (₹)<input data-field="unit_price" inputmode="decimal" value="${item.unit_price ?? ""}" placeholder="0.00"></label><label>Use-by (optional)<input data-field="estimated_use_by" type="date" value="${item.estimated_use_by}"></label><button type="button" class="plain remove-item"${reviewedItems.length === 1 ? " disabled" : ""}>Remove item</button></div></details></div></fieldset>`; }).join("");
  bindItemRows();
  updateItemTotal();
}
function bindItemRows() {
  document.querySelectorAll("[data-item]").forEach(rowElement => {
    const index = Number(rowElement.dataset.item);
    rowElement.querySelectorAll("[data-field]").forEach(input => input.oninput = () => {
      const field = input.dataset.field;
      const wasMerchandise = isRestockMerchandise(reviewedItems[index].name);
      reviewedItems[index][field] = input.type === "checkbox" ? input.checked : input.value;
      if (field === "is_personal") reviewedItems[index].is_tracked_for_restock = !input.checked && isRestockMerchandise(reviewedItems[index].name);
      if (field === "name") reviewedItems[index].is_tracked_for_restock = isRestockMerchandise(input.value) && (reviewedItems[index].is_tracked_for_restock || !wasMerchandise);
      if (field === "is_personal") renderItemRows();
      if (field === "name") { const restock = rowElement.querySelector('[data-field="is_tracked_for_restock"]'); restock.checked = reviewedItems[index].is_tracked_for_restock; restock.disabled = reviewedItems[index].is_personal || !isRestockMerchandise(input.value); }
      updateItemTotal();
    });
    rowElement.querySelector(".remove-item").onclick = () => { reviewedItems.splice(index, 1); renderItemRows(); };
  });
}
function updateItemTotal() {
  const sum = reviewedItems.reduce((total, item) => total + (Number(item.line_total) || 0), 0);
  const rawReceiptTotal = $("amount").value.trim();
  if (!rawReceiptTotal) {
    $("item-total").textContent = `Reviewed items: ${money(sum)} · Receipt total: needs confirmation · Difference unavailable`;
    return;
  }
  const receiptTotal = Number(rawReceiptTotal);
  if (!Number.isFinite(receiptTotal)) {
    $("item-total").textContent = `Reviewed items: ${money(sum)} · Receipt total: needs confirmation · Difference unavailable`;
    return;
  }
  const difference = receiptTotal - sum;
  $("item-total").textContent = `Reviewed items: ${money(sum)} · Receipt total: ${money(receiptTotal)}${Math.abs(difference) > .005 ? ` · Difference: ${money(difference)}` : " · Totals match"}`;
}
function duplicateRestoreControl() {
  let button = $("restore-duplicate-receipt");
  if (button) return button;
  button = document.createElement("button");
  button.id = "restore-duplicate-receipt";
  button.type = "button";
  button.className = "secondary hide";
  button.textContent = "Restore removed receipt";
  $("dialog-error").insertAdjacentElement("afterend", button);
  return button;
}
function openEntry(next, defaults = {}, pdfImport) {
  if (next !== "edit") editingPurchase = undefined;
  mode = next;
  pendingPdfImport = pdfImport;
  reviewedItems = (pdfImport?.items || []).map(emptyReviewedItem);
  dialog.classList.toggle("pdf-review-dialog", !!pdfImport);
  $("dialog-title").textContent = next === "settlement" ? "Record settlement" : pdfImport ? "Review PDF import" : defaults.personal ? "Add personal expense" : "Add expense";
  $("dialog-kicker").textContent = pdfImport ? "LOCAL PDF DRAFT" : "NEW ENTRY";
  const parserMessage = pdfImport?.parserWarning || pdfImport?.parserNotice || "";
  $("dialog-help").textContent = pdfImport ? `The PDF and extracted text remain local and are discarded when this draft closes. Non-personal items are tracked for restock by default; uncheck any you do not want suggested. Review every field before saving.${parserMessage ? ` ${parserMessage}` : ""}` : "";
  $("dialog-help").classList.toggle("parser-warning", !!pdfImport?.parserWarning);
  $("expense-fields").classList.toggle("hide", next === "settlement");
  $("pdf-items").classList.toggle("hide", !pdfImport);
  $("settlement-fields").classList.toggle("hide", next !== "settlement");
  $("settlement-copy").textContent = `You are recording a payment to ${displayedMemberName(partner())}.`;
  $("label").required = next !== "settlement";
  $("label").value = defaults.label || "";
  $("category").value = defaults.category || "Groceries";
  populatePayers(defaults.paid_by || session.user.id);
  $("personal").checked = !!defaults.personal;
  $("personal").disabled = !!pdfImport;
  $("amount").readOnly = false;
  $("amount").value = defaults.amount || "";
  $("date").value = defaults.date || today();
  $("dialog-error").textContent = "";
  const restoreDuplicate = duplicateRestoreControl();
  restoreDuplicate.classList.add("hide");
  restoreDuplicate.disabled = false;
  restoreDuplicate.onclick = null;
  setAiProcessing(AI_IDLE_MESSAGE);
  $("save").disabled = false;
  $("save").textContent = "Save";
  if (pdfImport) renderItemRows();
  dialog.showModal();
  requestAnimationFrame(() => (next === "settlement" ? $("amount") : $("label")).focus());
}
function closeEntry() {
  if (pendingPdfImport && !confirm("Discard this local PDF draft? The PDF and extracted text will not be stored.")) return;
  if (editingPurchase && formDirty && !confirm("Discard your unsaved receipt changes?")) return;
  pendingPdfImport = undefined;
  editingPurchase = undefined;
  reviewedItems = [];
  $("local-extracted-reference").value = "";
  $("sanitized-lines").value = "";
  formDirty = false;
  dialog.close();
}
$("prepare-ai").onclick = () => {
  if (!pendingPdfImport) return;
  $("sanitized-lines").value = (pendingPdfImport.sanitizationLines || []).join("\n");
  $("local-extracted-reference").value = pendingPdfImport.localExtractedText || "";
  $("confirm-sanitized").checked = false;
  $("ai-preview-error").textContent = "";
  aiPreviewDialog.showModal();
  requestAnimationFrame(() => $("sanitized-lines").focus());
};
function closeAiPreview() { aiPreviewDialog.close(); }
$("close-ai-preview").onclick = closeAiPreview;
$("cancel-ai-preview").onclick = closeAiPreview;
aiPreviewDialog.addEventListener("cancel", event => { event.preventDefault(); closeAiPreview(); });
$("ai-preview-form").onsubmit = async event => {
  event.preventDefault();
  const errorBox = $("ai-preview-error");
  const button = $("submit-ai");
  if (!pendingPdfImport || !session?.access_token || !current?.id) return;
  if (!$("confirm-sanitized").checked) { errorBox.textContent = "Review the preview and confirm that it contains no private information."; return; }
  try {
    const lines = validateSanitizedText($("sanitized-lines").value);
    const derivative = buildSanitizedPdf(lines.join("\n"));
    const formData = new FormData();
    formData.set("derivative", derivative, "sanitized-receipt.pdf");
    formData.set("household_id", current.id);
    pendingPdfImport.aiIdempotencyKey ||= crypto.randomUUID();
    formData.set("idempotency_key", pendingPdfImport.aiIdempotencyKey);
    formData.set("sanitizer_version", AI_SANITIZER_VERSION);
    formData.set("page_count", "1");
    formData.set("sanitized", "true");
    button.disabled = true;
    button.textContent = "Submitting…";
    const response = await fetch(`${SUPABASE_URL}/functions/v1/sarvam-receipt-parse`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_PUBLISHABLE_KEY }, body: formData });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(aiParseMessage(result.code));
    if (!/^[0-9a-f-]{36}$/i.test(result.job_id || "")) throw new Error(aiParseMessage("invalid_provider_result"));
    pendingPdfImport.aiJobId = result.job_id;
    closeAiPreview();
    setAiProcessing("Sarvam accepted the redacted derivative and is preparing suggestions…", true);
    void pollAiReceiptResult(result.job_id, pendingPdfImport);
  } catch (error) {
    errorBox.textContent = error.message || aiParseMessage();
  } finally {
    button.disabled = false;
    button.textContent = "Send redacted derivative";
  }
};
function setAiProcessing(message, busy = false) {
  aiProcessingStatus.textContent = message;
  aiProcessingStatus.classList.toggle("active", message !== AI_IDLE_MESSAGE);
  $("prepare-ai").disabled = busy;
  $("prepare-ai").textContent = busy ? "AI processing…" : "Prepare private AI preview";
}
async function pollAiReceiptResult(jobId, draftReference) {
  let transientFailures = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (pendingPdfImport !== draftReference || draftReference.aiJobId !== jobId) return;
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/sarvam-receipt-result`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" }, body: JSON.stringify({ job_id: jobId, household_id: current.id }) });
      const result = await response.json().catch(() => ({}));
      const decision = aiPollDecision(response.status, result.code, transientFailures);
      if (decision.kind === "wait") {
        transientFailures = 0;
        setAiProcessing("Sarvam is reading the redacted receipt. Your local draft remains available…", true);
        const seconds = Math.min(10, Math.max(2, Number(response.headers.get("retry-after")) || 3));
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        continue;
      }
      if (decision.kind === "retry") {
        transientFailures = decision.nextFailures;
        setAiProcessing(`Connection interrupted. Retrying AI result ${transientFailures} of 3; your local draft is safe…`, true);
        await new Promise(resolve => setTimeout(resolve, aiRetryDelayMs(transientFailures)));
        continue;
      }
      if (decision.kind !== "complete") throw new Error(aiParseMessage(result.code));
      const aiDraft = validateAiDraft(result.draft);
      if (pendingPdfImport !== draftReference) return;
      setAiProcessing("AI suggestions are ready. Choose whether to apply them to this local draft.");
      if (confirm("The private AI draft is ready. Replace the current local item suggestions with it? You must still review every field before saving.")) {
        $("label").value = aiDraft.defaults.label;
        if (aiDraft.defaults.amount) $("amount").value = aiDraft.defaults.amount;
        if (aiDraft.defaults.date) $("date").value = aiDraft.defaults.date;
        reviewedItems = aiDraft.items.map(emptyReviewedItem);
        renderItemRows();
        formDirty = true;
        setAiProcessing("AI suggestions applied locally. Review every field before saving; nothing was saved automatically.");
      } else setAiProcessing("AI suggestions were not applied. Your existing local draft is unchanged.");
      return;
    } catch (error) {
      const retry = aiNetworkPollDecision(transientFailures);
      if (error instanceof TypeError && retry.kind === "retry") {
        transientFailures = retry.nextFailures;
        setAiProcessing(`Connection interrupted. Retrying AI result ${transientFailures} of 3; your local draft is safe…`, true);
        await new Promise(resolve => setTimeout(resolve, aiRetryDelayMs(transientFailures)));
        continue;
      }
      if (pendingPdfImport === draftReference) setAiProcessing(`${error.message || aiParseMessage()} Continue reviewing or save the local draft.`);
      return;
    }
  }
  if (pendingPdfImport === draftReference) setAiProcessing(`${aiParseMessage("completion_timeout")} Continue reviewing or save the local draft.`);
}
function validateAiDraft(draft) {
  if (!draft || typeof draft !== "object" || !draft.defaults || !Array.isArray(draft.items) || !draft.items.length || draft.items.length > 100) throw new Error(aiParseMessage("invalid_provider_result"));
  const label = String(draft.defaults.label || "").trim().slice(0, 160);
  const amount = Number(draft.defaults.amount);
  if (!label || !Number.isFinite(amount) || amount <= 0) throw new Error(aiParseMessage("invalid_provider_result"));
  const items = draft.items.map(item => emptyReviewedItem(item));
  if (items.some(item => !item.name.trim() || !Number.isFinite(Number(item.line_total)) || Number(item.line_total) < 0)) throw new Error(aiParseMessage("invalid_provider_result"));
  if (Math.abs(items.reduce((sum, item) => sum + Number(item.line_total), 0) - amount) > .01) throw new Error(aiParseMessage("invalid_provider_result"));
  return { defaults: { label, amount: amount.toFixed(2), date: /^\d{4}-\d{2}-\d{2}$/.test(draft.defaults.date || "") ? draft.defaults.date : "" }, items };
}
$("close").onclick = closeEntry;
$("cancel").onclick = closeEntry;
dialog.addEventListener("cancel", event => { event.preventDefault(); closeEntry(); });
$("add-item").onclick = () => { reviewedItems.push(emptyReviewedItem()); renderItemRows(); };
$("amount").oninput = updateItemTotal;
$("entry-form").onsubmit = async event => {
  event.preventDefault();
  if (!active()) return;
  const errorBox = $("dialog-error");
  const amount = Number($("amount").value);
  if (!Number.isFinite(amount) || amount <= 0) { errorBox.textContent = "Enter an amount above zero."; return; }
  const button = $("save");
  button.disabled = true;
  button.textContent = "Saving…";
  let error;
  if (mode === "settlement") {
    const receiver = partner();
    if (!receiver) { errorBox.textContent = "Your partner must join before recording a settlement."; button.disabled = false; button.textContent = "Save"; return; }
    const latestBalance = balanceFor(session.user.id);
    const amountError = settlementAmountError(latestBalance, amount);
    if (amountError) { errorBox.textContent = amountError; button.disabled = false; button.textContent = "Save"; return; }
    const payer = displayedMemberName(members.find(member => member.user_id === session.user.id));
    const receiverName = displayedMemberName(receiver);
    if (!confirm(settlementConfirmation(payer, receiverName, amount, $("date").value))) { button.disabled = false; button.textContent = "Save"; return; }
    ({ error } = await supabase.from("settlements").insert({ household_id: current.id, payer: session.user.id, receiver: receiver.user_id, amount, settled_on: $("date").value }));
  } else {
    const label = $("label").value.trim();
    if (!label) { errorBox.textContent = "Add a merchant or description."; button.disabled = false; button.textContent = "Save"; return; }
    const paidBy = $("paid-by").value;
    if (!members.some(member => member.user_id === paidBy)) { errorBox.textContent = "Choose a current household member who paid this expense."; button.disabled = false; button.textContent = "Save"; return; }
    const personal = $("personal").checked;
    if (!personal && !hasPartner()) { errorBox.textContent = "Your partner must join before saving a shared expense."; button.disabled = false; button.textContent = "Save"; return; }
    if (mode === "edit" && editingPurchase) {
      const changes = receiptEditChanges(editingPurchase, { label, category: $("category").value, paidBy, purchasedOn: $("date").value, amount, personal });
      let request = supabase.from("purchases").update(changes).eq("id", editingPurchase.id).eq("household_id", current.id);
      if (!isOwner()) request = request.eq("paid_by", session.user.id);
      const result = await request.select("id").maybeSingle();
      error = result.error || (!result.data ? { message: "This receipt can only be edited by its payer or the household owner." } : undefined);
    } else if (pendingPdfImport) {
      const items = reviewedItems.map((item, display_order) => ({ name: item.name.trim(), quantity: item.quantity === "" ? null : Number(item.quantity), unit: item.unit.trim() || null, unit_price: item.unit_price === "" || item.unit_price == null ? null : Number(item.unit_price), line_total: item.line_total === "" || item.line_total == null ? null : Number(item.line_total), is_personal: !!item.is_personal, is_tracked_for_restock: !item.is_personal && isRestockMerchandise(item.name) && !!item.is_tracked_for_restock, estimated_use_by: item.estimated_use_by || null, display_order }));
      if (!items.length || items.some(item => !item.name)) { errorBox.textContent = "Every reviewed item needs a name."; button.disabled = false; button.textContent = "Save"; return; }
      if (items.some(item => item.line_total == null)) { errorBox.textContent = "Every reviewed item needs a line total."; button.disabled = false; button.textContent = "Save"; return; }
      if (items.some(item => item.quantity != null && (!Number.isFinite(item.quantity) || item.quantity <= 0))) { errorBox.textContent = "Item quantities must be above zero."; button.disabled = false; button.textContent = "Save"; return; }
      if (items.some(item => [item.unit_price, item.line_total].some(value => value != null && (!Number.isFinite(value) || value < 0)))) { errorBox.textContent = "Item prices and line totals cannot be negative."; button.disabled = false; button.textContent = "Save"; return; }
      const reviewedTotal = items.reduce((total, item) => total + (item.line_total || 0), 0);
      if (Math.abs(reviewedTotal - amount) > .005) { errorBox.textContent = "Reviewed item totals must match the receipt total before saving."; button.disabled = false; button.textContent = "Save"; return; }
      const allPersonal = items.every(item => item.is_personal);
      ({ error } = await supabase.rpc("import_reviewed_purchase", { p_household_id: current.id, p_paid_by: paidBy, p_exact_pdf_hash: pendingPdfImport.exactHash, p_content_hash: pendingPdfImport.contentHash, p_label: label, p_category: $("category").value, p_amount: amount, p_purchased_on: $("date").value, p_is_personal: allPersonal, p_items: items }));
    } else {
      ({ error } = await supabase.from("purchases").insert({ household_id: current.id, label, category: $("category").value, amount, paid_by: paidBy, purchased_on: $("date").value, is_personal: personal, is_tracked_for_restock: false, estimated_use_by: null }));
    }
  }
  if (error) {
    if (pendingPdfImport && isDuplicateImportError(error)) {
      const lookup = await findInvoiceDuplicate(pendingPdfImport);
      const result = lookup.error || duplicateState(lookup.result) === "none" ? { duplicate_status: "ambiguous" } : lookup.result;
      const duplicateMessage = duplicateImportMessage(result);
      lastPdfFeedback = { exactHash: pendingPdfImport.exactHash, contentHash: pendingPdfImport.contentHash, message: duplicateMessage, result };
      errorBox.textContent = duplicateMessage;
      errorBox.tabIndex = -1;
      errorBox.focus();
      note("");
      const restoreButton = duplicateRestoreControl();
      const existing = duplicatePurchase(result);
      const restoreId = restorableDuplicatePurchaseId(result);
      const canRestore = !!restoreId;
      restoreButton.classList.toggle("hide", !canRestore);
      restoreButton.setAttribute("aria-label", canRestore ? `Restore ${existing?.label || "removed receipt"} to the ledger` : "");
      restoreButton.onclick = canRestore ? async () => {
        restoreButton.disabled = true;
        if (await restoreRemovedReceipt(restoreId, "duplicate")) {
          pendingPdfImport = undefined;
          reviewedItems = [];
          $("local-extracted-reference").value = "";
          $("sanitized-lines").value = "";
          formDirty = false;
          dialog.close();
        } else restoreButton.disabled = false;
      } : null;
      button.disabled = false;
      button.textContent = "Save receipt";
      return;
    }
    errorBox.textContent = `${error.message || "Could not save."} Your draft is still here; check your connection and retry.`;
    button.disabled = false;
    button.textContent = "Try saving again";
    return;
  }
  pendingPdfImport = undefined;
  editingPurchase = undefined;
  reviewedItems = [];
  $("local-extracted-reference").value = "";
  $("sanitized-lines").value = "";
  formDirty = false;
  dialog.close();
  note(mode === "edit" ? "Receipt updated and shared." : `${mode === "settlement" ? "Settlement" : "Expense"} saved and shared.`);
  await loadLedger();
};

async function archiveEntry(type, id) {
  if (type === "purchase") return deleteReceipt(id);
  if (!confirm("Archive this entry? It will stop affecting balances and restock suggestions.")) return;
  const { error } = await supabase.from("settlements").update({ archived_at: new Date().toISOString(), archived_by: session.user.id }).eq("id", id);
  note(error ? error.message : "Entry archived.");
  if (!error) await loadLedger();
}
async function restoreEntry(type, id) {
  if (type === "purchase") return restoreRemovedReceipt(id, "settings");
  const { error } = await supabase.from("settlements").update({ archived_at: null, archived_by: null }).eq("id", id);
  note(error ? error.message : "Settlement restored; balance was recalculated.");
  if (!error) await loadLedger();
}
async function restoreRemovedReceipt(id, source) {
  const { error } = await supabase.rpc("restore_purchase_receipt", { p_purchase_id: id });
  if (error) { note(error.message); return false; }
  forgetRemovedReceipt(sessionStorage, id);
  lastPdfFeedback = undefined;
  clearImportFeedback(document);
  note(source === "duplicate" ? "Removed receipt restored. No duplicate was created." : "Receipt restored to the ledger; balances and Possible Buys were recalculated.");
  await loadLedger();
  return true;
}
async function deleteReceipt(id) {
  const purchase = ledger.purchases.find(item => item.id === id);
  if (!purchase || !confirm("Remove this receipt from the ledger? It will stop affecting balances and Possible Buys, but it remains restorable from Household settings.")) return;
  const { error } = await supabase.rpc("delete_purchase_receipt", { p_purchase_id: id });
  if (error) return note(error.message);
  rememberRemovedReceipt(sessionStorage, current.id, session.user.id, id);
  note("Receipt removed from the ledger. It remains restorable.");
  await loadLedger();
}
function editReceipt(id) {
  const purchase = ledger.purchases.find(item => item.id === id);
  if (!canManageReceipt(purchase, session.user.id, isOwner(), active())) return;
  editingPurchase = purchase;
  const itemized = !!purchase.purchase_items?.length;
  openEntry("edit", { label: purchase.label, category: purchase.category, paid_by: purchase.paid_by, amount: purchase.amount, date: purchase.purchased_on, personal: purchase.is_personal });
  editingPurchase = purchase;
  $("dialog-kicker").textContent = "SAVED RECEIPT";
  $("dialog-title").textContent = "Edit receipt";
  $("dialog-help").textContent = itemized ? "Update the receipt details below. Reviewed items and their reconciled total stay unchanged." : "Update this manual receipt entry. Changes recalculate the shared ledger immediately.";
  $("amount").readOnly = itemized;
  $("personal").disabled = itemized;
  $("save").textContent = "Update receipt";
  formDirty = false;
}
async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function readPdfLocally(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const exactHash = await sha256(bytes);
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    note(`Reading page ${pageNumber} of ${pdf.numPages} locally…`);
    const content = await (await pdf.getPage(pageNumber)).getTextContent();
    pages.push(content.items.map(item => ({
      page: pageNumber,
      x: Number(item.transform?.[4]) || 0,
      y: Number(item.transform?.[5]) || 0,
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      text: String(item.str || "").trim()
    })).filter(item => item.text));
  }
  await pdf.destroy();
  const extractedText = pages.flatMap(page => page.map(token => token.text)).join("\n");
  const normalized = extractedText.toLowerCase().replace(/[^a-z0-9.,₹\n ]/g, "").replace(/[ \t]+/g, " ").trim();
  const parsed = parseReceipt(pages, today());
  return { exactHash, contentHash: await sha256(normalized), localExtractedText: extractedText, sanitizationLines: suggestedSanitizedLines(parsed), ...parsed };
}
function setPdfBusy(busy) {
  const button = $("import-pdf");
  if (button) {
    button.disabled = busy;
    button.textContent = busy ? "Checking receipt…" : "Import receipt";
  }
  if (busy) $("sync-state").textContent = "Reading receipt…";
  else $("sync-state").textContent = navigator.onLine ? "Synced" : "Offline";
}
$("pdf-file").onchange = async event => {
  const input = event.target;
  const file = event.target.files?.[0];
  if (!file) return;
  if (!active() || !hasPartner()) { input.value = ""; return; }
  if (!file.name.toLowerCase().endsWith(".pdf")) { input.value = ""; return note("Choose a PDF receipt or invoice."); }
  clearImportFeedback(document);
  setPdfBusy(true);
  try {
    note("Reading this PDF locally. It will not be uploaded or stored.");
    const imported = await readPdfLocally(file);
    if (sameFingerprint(imported, pendingPdfImport)) {
      const message = "This receipt is already open in the current review draft. Continue reviewing it or close the draft before choosing another file.";
      $("dialog-error").textContent = message;
      note("");
      return;
    }
    if (sameFingerprint(imported, lastPdfFeedback)) {
      showDuplicateImport(lastPdfFeedback.result, imported);
      return;
    }
    const { result, error } = await findInvoiceDuplicate(imported);
    if (error) { showImportFeedback(`Could not check whether this receipt was already imported. ${error.message}`, "error"); return; }
    if (duplicateState(result) !== "none") {
      showDuplicateImport(result, imported);
      return;
    }
    openEntry("expense", imported.defaults, imported);
    note("Local draft ready. Review every item before saving.");
  } catch (error) {
    showImportFeedback(`Could not read this PDF locally: ${error.message}. Nothing was uploaded. Choose the file again to retry.`, "error");
  } finally {
    input.value = "";
    setPdfBusy(false);
  }
};

function unsafeForRefresh() {
  return hasUnsafeDraft({ dialogOpen: dialog.open, pendingPdfImport, formDirty });
}
function showUpdateAvailable(nextBuild) {
  let banner = $("update-available");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "update-available";
    banner.className = "update-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    document.querySelector("header")?.insertAdjacentElement("afterend", banner);
  }
  banner.innerHTML = '<span><b>Update available</b><small>Refresh after saving or closing your draft.</small></span><button type="button" class="secondary">Refresh now</button>';
  banner.querySelector("button").onclick = () => {
    if (unsafeForRefresh()) { banner.querySelector("small").textContent = "Save or close your current draft before refreshing."; return; }
    sessionStorage.setItem(reloadVersionKey, nextBuild);
    location.reload();
  };
}
async function checkForSiteUpdate() {
  try {
    const versionUrl = new URL("./version.json", import.meta.url);
    versionUrl.searchParams.set("t", Date.now());
    const response = await fetch(versionUrl, { cache: "no-store" });
    if (!response.ok) return;
    const nextBuild = String((await response.json())?.build || "").trim();
    const attempted = sessionStorage.getItem(reloadVersionKey) || "";
    if (attempted === clientBuild) sessionStorage.removeItem(reloadVersionKey);
    const action = versionAction(clientBuild, nextBuild, unsafeForRefresh(), attempted);
    if (action === "reload") {
      sessionStorage.setItem(reloadVersionKey, nextBuild);
      location.reload();
    } else if (action === "prompt") showUpdateAvailable(nextBuild);
  } catch { /* Update checks are deliberately non-blocking. */ }
}
setTimeout(checkForSiteUpdate, 5000);
setInterval(checkForSiteUpdate, 180000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForSiteUpdate(); });
window.addEventListener("focus", checkForSiteUpdate);

renderLoading("Checking your saved session…");
window.addEventListener("offline", () => { $("sync-state").textContent = "Offline"; note("You’re offline. Unsaved form and PDF review fields remain in this browser; reconnect before saving."); });
window.addEventListener("online", () => { $("sync-state").textContent = "Back online"; note("Connection restored. Retry the last action when you’re ready."); });
supabase.auth.onAuthStateChange((event, nextSession) => {
  if (event === "INITIAL_SESSION") return;
  if (nextSession) {
    session = nextSession;
    if (!restorePromise && !verifyingOtp) loadHousehold();
    return;
  }
  if (event === "SIGNED_OUT" && explicitSignOut) return;
  setTimeout(restoreSavedSession, 0);
});
restoreSavedSession();
