import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";
import { applyPresentation, readPresentation, savePresentation } from "./appearance.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";
import { classifySignInError } from "./auth-errors.js";
import { contentFingerprintIsReliable, isDuplicateImportError, sameFingerprint } from "./duplicate-import.js";
import { clearImportFeedback, showImportFeedback as renderImportFeedback } from "./import-feedback.js";
import { duplicateMatchBasis, duplicateState, isExactDuplicate, restorableDuplicatePurchaseId } from "./invoice-duplicate.js";
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
import { aiParseMessage } from "./ai-receipt-sanitizer.js";
import { AI_EXPECTED_TIME_COPY, AI_MAX_RETRY_AFTER_SECONDS, AI_POLL_ATTEMPTS, aiNetworkPollDecision, aiPollDecision, aiProgressMessage, aiRetryDelayMs } from "./ai-receipt-flow.js";
import { createFlattenedVisualDerivative, hasRememberedVisualLayout, planVisualDerivative, rememberVisualLayout, revokeVisualDerivativePreview } from "./ai-visual-derivative.js";
import { hasUnidentifiedAiItems, reconcileAiItemNames } from "./ai-item-names.js";
import { resolveAiReceiptTotal } from "./ai-receipt-total.js";
import { withItemSumReviewAmount } from "./receipt-review-total.js";
import { chronologicalBalance } from "./balance.js";
import { receiptSettlementAllocations } from "./settlement-allocations.js";
import { householdRhythmTimeline } from "./purchase-timeline.js";
import { renderBalanceSummary, renderCommandActions, renderHouseholdRhythm } from "./home-rhythm-view.js";
import { normalizeReviewedItem, reviewedItemsForSave as itemsForSave, savedPurchaseItemsForReview } from "./reviewed-item-state.js";
import { renderReviewedItemRows } from "./reviewed-item-view.js";
import { importReviewedPurchase, loadReviewedPurchases, updateReviewedPurchase } from "./reviewed-purchase-store.js";
import { duplicateRestoreAction } from "./duplicate-restore-action.js";

const authStorage = createResilientAuthStorage(window.localStorage);
const AI_IDLE_MESSAGE = "AI processing is ready to begin.";
document.querySelector("footer").textContent = "Original PDFs stay local · only an explicitly reviewed private derivative may be sent for Private AI processing · no payment method, address, card, or UPI details persist";
document.querySelector("#pdf-items > .dialog-help").textContent = "Edit or remove anything the selected processing method got wrong. Only these reviewed fields will sync.";
document.querySelector("#visual-ai-preview .dialog-help").textContent = "Only the original item-table pixels shown below will be sent. Everything outside approved item cells was masked locally; the original receipt remains on this device.";
const supabase = globalThis.__GROCERY_LEDGER_TEST_CLIENT__ || createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: authStorage }
});
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);
const viewAiInputButton = document.createElement("button");
viewAiInputButton.id = "view-ai-input";
viewAiInputButton.type = "button";
viewAiInputButton.className = "secondary inspect-ai-input hide";
viewAiInputButton.textContent = "View what AI receives";
viewAiInputButton.setAttribute("aria-describedby", "import-choice-privacy");
document.querySelector(".processing-choices").insertAdjacentElement("afterend", viewAiInputButton);
document.querySelector("#import-choice > form > .dialog-help").id = "import-choice-privacy";
const today = () => new Date().toISOString().slice(0, 10);
const money = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(n) || 0);
const fmt = d => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d}T12:00:00`));
const fmtTimestamp = d => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(d));
const esc = text => String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const retryKey = "grocery-ledger-email-retry-at";
const rememberedEmailKey = "grocery-ledger-last-email";
const dialog = $("entry");
let entryInvoker = null;
const discardPdfDraftDialog = $("discard-pdf-draft");
const visualAiPreviewDialog = $("visual-ai-preview");
const importChoiceDialog = $("import-choice");
const importProcessingDialog = $("import-processing");
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
let ledger = { purchases: [], settlements: [], settlementAllocations: [], archivedPurchases: [], archivedSettlements: [] };
let channel;
let mode = "expense";
let pendingPdfImport;
let stagedPdfImport;
let editingPurchase;
let pendingReceiptRemovalId;
let pendingReceiptPurgeId;
let reviewedItems = [];
let receiptReviewConfirmed = false;
let expandedItemIndex = null;
let preparedVisualDerivative;
let stagedAiProcessed;
let aiInputPreviewMode = "";
let lastPdfFeedback;
let formDirty = false;
let explicitSignOut = false;
let restorePromise;
let verifyingOtp = false;
let dashboardView = "home";
let rhythmSelectedDate;
let rhythmShowAll = false;

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
  const contentOnly = duplicateMatchBasis(result) === "content";
  const existing = duplicatePurchase(result);
  const identity = existing ? ` as ${existing.label} from ${fmt(existing.purchased_on)}` : "";
  if (contentOnly) {
    if (status === "linked_archived_restorable") return "This is a different PDF, but its locally calculated content fingerprint collides with a removed receipt. Nothing was imported. Restore the removed receipt only if it is the receipt you intended to recover.";
    if (status === "linked_archived_not_authorized") return "This is a different PDF, but its locally calculated content fingerprint collides with a removed receipt. Nothing was imported. Its payer or the household owner can inspect the removed receipt.";
    if (status === "linked_active") return "This PDF differs, but its locally calculated receipt details match a saved receipt. Nothing was imported. Review the existing receipt before trying again; the original PDF remains only on this device.";
    if (status === "legacy_unlinked") return "This is not confirmed as the same receipt. Its locally calculated content fingerprint collides with a legacy import reservation. Nothing was imported; use Check and reimport only if the ledger can safely release that reservation.";
    return "This is not confirmed as the same receipt. Its locally calculated content fingerprint collides with more than one import record, so nothing was imported. Keep this PDF available for reconciliation.";
  }
  if (status === "linked_archived_restorable") return `This receipt was already imported${identity} and later removed. Restore it instead of importing another copy.`;
  if (status === "linked_archived_not_authorized") return "This receipt was already imported and later removed. Only its payer or the household owner can restore it.";
  if (status === "linked_active") return `This receipt was already imported${identity}. No new expense was added.`;
  if (status === "legacy_unlinked") return "This receipt matches an earlier import, but its original ledger entry cannot be linked safely. No new expense was added.";
  return "This receipt matches more than one earlier import and cannot be linked safely. No new expense was added.";
}
async function findInvoiceDuplicate(fingerprint) {
  const lookupContentHash = fingerprint.contentHashReliable === false ? fingerprint.exactHash : fingerprint.contentHash;
  const { data, error } = await supabase.rpc("find_invoice_duplicate", { p_household_id: current.id, p_exact_pdf_hash: fingerprint.exactHash, p_content_hash: lookupContentHash });
  return { result: Array.isArray(data) ? data[0] : data, error };
}
async function releaseOrphanedImport(fingerprint) {
  const { data, error } = await supabase.rpc("release_orphaned_invoice_fingerprints", { p_household_id: current.id, p_exact_pdf_hash: fingerprint.exactHash, p_content_hash: fingerprint.contentHash });
  return { released: Number(data) || 0, error };
}
function showDuplicateImport(result, fingerprint) {
  const existing = duplicatePurchase(result);
  const message = duplicateImportMessage(result);
  lastPdfFeedback = { exactHash: fingerprint?.exactHash, contentHash: fingerprint?.contentHash, contentHashReliable: fingerprint?.contentHashReliable, message, result };
  const restoreId = isExactDuplicate(result) ? restorableDuplicatePurchaseId(result) : null;
  const orphaned = duplicateState(result) === "legacy_unlinked";
  const action = duplicateRestoreAction({ restoreId, existingLabel: existing?.label, restore: id => restoreRemovedReceipt(id, "duplicate") })
    || (orphaned ? { label: "Check and reimport", ariaLabel: "Ask the ledger to verify and release this orphaned import reservation", onClick: async event => {
      event.currentTarget.disabled = true;
      const release = await releaseOrphanedImport(fingerprint);
      if (release.error || !release.released) { showImportFeedback(`This reservation could not be released safely. ${release.error?.message || "The database did not approve it."}`, "error", { durationMs: 0 }); return; }
      lastPdfFeedback = undefined;
      clearImportFeedback(document);
      openImportChoice(fingerprint);
      note("The orphaned reservation was released. Choose how to process this invoice; nothing has been saved yet.");
    } } : undefined);
  return showImportFeedback(message, "duplicate", action ? { durationMs: 0, action } : undefined);
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
  document.querySelector("header .app-navigation")?.remove();
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
  ledger = { purchases: [], settlements: [], settlementAllocations: [], archivedPurchases: [], archivedSettlements: [] };
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
  return items.reduce((total, item) => total + (item.include_in_total === false ? 0 : Number(item.shared_line_total ?? (item.is_personal ? 0 : item.line_total)) || 0), 0);
}
function settlementAllocations(receiver, amount, settledOn) {
  return receiptSettlementAllocations({
    purchases: ledger.purchases.map(purchase => ({ id: purchase.id, paid_by: purchase.paid_by, purchased_on: purchase.purchased_on, shared_amount: sharedPurchaseAmount(purchase) })),
    existingAllocations: ledger.settlementAllocations,
    receiver,
    amount,
    settledOn
  });
}
function balanceFor(userId) {
  if (!hasPartner()) return 0;
  const expenses = ledger.purchases.map(purchase => {
    const sharedAmount = sharedPurchaseAmount(purchase);
    return { date: purchase.purchased_on, amount: purchase.paid_by === userId ? sharedAmount / 2 : -sharedAmount / 2 };
  });
  const settlements = ledger.settlements.map(settlement => ({ date: settlement.settled_on, amount: settlement.payer === userId ? Number(settlement.amount) : settlement.receiver === userId ? -Number(settlement.amount) : 0 }));
  return chronologicalBalance(expenses, settlements);
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
  const support = item.allocation_count ? ` · ${item.allocation_count} active receipt allocation${item.allocation_count === 1 ? "" : "s"}` : "";
  return `<div class="expense"><div><b>${heading}</b><span>${fmt(item.settled_on)}${support}</span></div><div class="entry-actions"><b>${money(item.amount)}</b>${canManage && active() ? `<button class="plain action" data-archive="${type}" data-id="${item.id}">Archive</button>` : ""}</div></div>`;
}
function suggestionCards() {
  const { groups, stats } = restockEligibility(ledger.purchases);
  const dueItems = [];
  const cards = [...groups.values()].map(items => {
    items.sort((a, b) => a.purchased_on.localeCompare(b.purchased_on));
    const dates = [...new Set(items.map(item => item.purchased_on))];
    if (!qualifiesForRestockSuggestion(items)) return null;
    const [previous, last] = dates.slice(-2);
    const days = Math.max(1, Math.round((Date.parse(`${last}T12:00:00`) - Date.parse(`${previous}T12:00:00`)) / 86400000));
    const latest = items.at(-1);
    const due = latest.estimated_use_by || new Date(Date.parse(`${last}T12:00:00`) + days * 86400000).toISOString().slice(0, 10);
    dueItems.push({ due, name: latest.display_name });
    const timing = due <= today() && latest.purchase_id
      ? `<button type="button" class="restock-review" data-review-restock="${latest.purchase_id}" data-review-name="${esc(latest.display_name)}" aria-label="Review ${esc(latest.display_name)} in its latest receipt">Review now</button>`
      : `<time class="restock-timing${due <= today() ? " due" : ""}" datetime="${due}">${due <= today() ? "Review due" : `Around ${fmt(due)}`}</time>`;
    return `<div class="suggestion"><div><b>${esc(latest.display_name)}</b><span>${latest.estimated_use_by ? "Reviewed use-by" : `Latest interval: ${days} days`} · bought ${dates.length} times</span></div>${timing}</div>`;
  }).filter(Boolean);
  const guidance = restockEmptyGuidance(groups, stats);
  return {
    cards,
    dueItems,
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
  const balanceText = Math.abs(balance) < .005 ? `You and ${otherName} are settled` : balance > 0 ? `${otherName} owes you ${money(balance)}` : `You owe ${otherName} ${money(-balance)}`;
  const settlement = settlementState(balance, currentName, otherName);
  return renderBalanceSummary({ balanceText, guidance: settlement.kind === "settled" ? "" : settlement.guidance, actionLabel: settlement.actionLabel, actionAmount: money(settlement.amount), archived });
}
function renderSettings(balance, archived, recoveryOpen, expanded = false) {
  const ownerControls = isOwner() ? archived ? `<div class="danger-zone">${recoveryOpen ? `<button id="restore-household" class="secondary">Restore household</button><small>Recovery is available until ${fmt(current.purge_after)}.</small>` : `<button id="delete-household" class="danger">Permanently delete</button><small>The 30-day recovery period has ended.</small>`}</div>` : `<div class="danger-zone"><b>Close household</b><small>${Math.abs(balance) >= .005 ? "Settle the balance before closing." : "Starts a 30-day recovery period."}</small><button id="archive-household" class="danger"${Math.abs(balance) >= .005 ? " disabled" : ""}>Close household</button></div>` : "";
  const archivedEntries = [...ledger.archivedPurchases.map(item => ({ ...item, type: "purchase" })), ...ledger.archivedSettlements.map(item => ({ ...item, type: "settlement" }))];
  const memberRows = members.map(member => `<div class="expense"><div><b>${esc(displayedMemberName(member))}</b><span>${member.role === "owner" ? "Owner" : "Partner"}${member.user_id === session.user.id ? " · you" : ""}</span></div></div>`).join("");
  const nameForm = archived ? "" : `<form id="display-name-form" class="inline-form"><label>Your display name<input id="display-name" maxlength="80" required autocomplete="name" value="${esc(memberDisplayName(members.find(member => member.user_id === session.user.id)))}"></label><button class="secondary">Update name</button></form>`;
  const archiveRows = archivedEntries.length ? archivedEntries.map(item => {
    const canRestore = active() && (isOwner() || (item.type === "purchase" ? item.paid_by : item.payer) === session.user.id);
    const restore = canRestore ? `<button class="secondary" data-restore-entry="${item.type}" data-id="${item.id}">${item.type === "purchase" ? "Restore to ledger" : "Restore settlement"}</button>` : "";
    const purge = active() && isOwner() && item.type === "purchase" ? `<button class="archive-purge" data-purge-receipt="${item.id}" aria-label="Delete ${esc(item.label)} permanently">Delete permanently</button>` : "";
    return `<div class="expense archived-entry"><div><b>${item.type === "purchase" ? `Removed receipt: ${esc(item.label)}` : "Archived settlement"}</b><span>${money(item.amount)} · ${item.type === "purchase" ? `Removed ${fmtTimestamp(item.archived_at)}${item.archived_by ? ` by ${esc(memberName(item.archived_by))}` : ""}` : `Archived ${fmtTimestamp(item.archived_at)}`}</span></div>${restore || purge ? `<div class="archived-entry-actions">${restore}${purge}</div>` : ""}</div>`;
  }).join("") : `<p class="settings-empty">No removed receipts or archived settlements.</p>`;
  const recovery = `<section class="settings-recovery" aria-labelledby="settings-recovery-title"><div class="settings-section-heading"><b id="settings-recovery-title">Receipt recovery</b><small>Restore removed ledger entries or permanently delete receipts you own.</small></div><div class="archive-list">${archiveRows}</div></section>`;
  const accountSession = `<section class="account-session" aria-labelledby="account-session-title"><div><b id="account-session-title">Account and session</b><small>Sign out of Grocery Ledger on this browser.</small></div><button id="sign-out" class="secondary session-sign-out">Sign out</button></section>`;
  return `<details id="household-settings" class="panel settings"${expanded ? " open" : ""}><summary><span><b>Household settings</b><small>Recovery, members and account</small></span><span aria-hidden="true">Open</span></summary><div class="settings-body">${recovery}<div class="settings-columns"><section class="settings-profile" aria-labelledby="settings-members-title"><div class="settings-section-heading"><b id="settings-members-title">Household members</b><small>Two people share this ledger.</small></div><div class="member-list">${memberRows}</div>${nameForm}</section><section class="settings-account" aria-label="Account and session">${accountSession}</section></div>${ownerControls}</div></details>`;
}
function renderRemovalUndo() {
  const purchase = readRemovedReceipt(sessionStorage, current.id, session.user.id, ledger.archivedPurchases);
  if (!purchase || !canManageReceipt(purchase, session.user.id, isOwner(), active())) return "";
  return `<section class="removal-undo" role="status" aria-live="polite"><span><b>${esc(purchase.label)} was removed from the ledger.</b><small>It no longer affects balances or Possible Buys and remains restorable.</small></span><button id="undo-receipt-removal" type="button" class="secondary" data-receipt-id="${purchase.id}">Undo</button></section>`;
}
function renderAppNavigation() {
  return `<nav class="app-navigation" aria-label="Grocery Ledger sections">${[["home", "Home"], ["receipts", "Receipts"], ["shopping", "Shopping"], ["household", "Household"]].map(([id, label]) => `<button type="button" data-dashboard-view="${id}" aria-controls="view-${id}"${dashboardView === id ? ' aria-current="page"' : ""}>${label}</button>`).join("")}</nav>`;
}
function mountDashboardNavigation() {
  const navigation = document.querySelector("#screen .app-navigation");
  const tools = document.querySelector("header .header-tools");
  if (navigation && tools) tools.insertAdjacentElement("beforebegin", navigation);
}
function renderWeekStrip() {
  const timeline = householdRhythmTimeline(ledger.purchases, today(), rhythmSelectedDate);
  rhythmSelectedDate = timeline.selectedDate;
  return renderHouseholdRhythm(timeline, fmt);
}
function uploadDateNote(item) {
  const uploaded = String(item.created_at || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(uploaded) && uploaded !== item.purchased_on ? ` · Uploaded ${fmt(uploaded)}` : "";
}
function renderHouseholdRecord(selectedDate = rhythmSelectedDate) {
  const allEvents = [...ledger.purchases.map(item => ({ date: item.purchased_on, kind: "receipt", id: item.id, title: item.label, detail: `${memberName(item.paid_by)} paid · ${money(item.amount)}${uploadDateNote(item)}` })), ...ledger.settlements.map(item => ({ date: item.settled_on, kind: "payment", title: `${memberName(item.payer)} paid ${memberName(item.receiver)}`, detail: `${money(item.amount)} · ${item.allocation_count || 0} active receipt allocation${item.allocation_count === 1 ? "" : "s"}` }))];
  const events = allEvents.filter(event => rhythmShowAll || !selectedDate || event.date === selectedDate).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  if (!events.length && !allEvents.length) return `<p class="empty-state">No receipts yet. Import or add the first receipt to start the household record.</p>`;
  if (!events.length) {
    const latest = [...ledger.purchases].sort((a, b) => b.purchased_on.localeCompare(a.purchased_on))[0]?.purchased_on;
    return `<div class="record-empty-context"><p>No activity on ${fmt(selectedDate)}. This household has ${ledger.purchases.length} receipt${ledger.purchases.length === 1 ? "" : "s"} on other purchase dates.</p><div><button type="button" class="secondary" data-rhythm-jump="${latest || ""}">Jump to latest receipt</button><button type="button" class="plain" data-show-all-history>Show all history</button></div></div>`;
  }
  return `<ol class="household-timeline">${events.map(event => `<li><span class="timeline-mark ${event.kind}" aria-hidden="true"></span><div><b>${esc(event.title)}</b><span>${esc(event.detail)}</span></div><time datetime="${event.date}">${fmt(event.date)}</time>${event.kind === "receipt" ? `<button type="button" class="plain timeline-link" data-open-receipt="${event.id}">View receipt</button>` : ""}</li>`).join("")}</ol>`;
}
function showDashboardView(view, focus = false) {
  dashboardView = ["home", "receipts", "shopping", "household"].includes(view) ? view : "home";
  document.querySelectorAll("[data-dashboard-panel]").forEach(panel => { panel.hidden = panel.dataset.dashboardPanel !== dashboardView; });
  document.querySelectorAll("[data-dashboard-view]").forEach(button => button.dataset.dashboardView === dashboardView ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current"));
  if (focus) {
    const heading = document.querySelector(`[data-dashboard-panel="${dashboardView}"] h2`);
    heading?.setAttribute("tabindex", "-1");
    heading?.focus();
  }
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
  const actions = renderCommandActions(archived);
  const archiveBanner = archived ? `<p class="archive-banner">This household is archived and read-only. ${recoveryOpen ? `It can be restored until ${fmt(current.purge_after)}.` : "Its recovery period has ended."}</p>` : "";
  const homeSuggestions = restock.cards.slice(0, 3).join("") || restock.empty;
  const receiptActions = archived ? "" : `<div class="view-actions"><button type="button" data-import-pdf>Import receipt</button><button type="button" class="secondary" data-add-expense>Add expense</button></div>`;
  setScreen(`<section class="dashboard-shell"><section class="household-masthead"><div class="household-title"><p>HOUSEHOLD</p><h1 tabindex="-1">${esc(current.name)}</h1></div><div class="member-blocks" aria-label="Household members">${renderMembers()}</div></section>${archiveBanner}${renderAppNavigation()}<section id="view-home" class="ledger-view household-rhythm" data-dashboard-panel="home"${dashboardView === "home" ? "" : " hidden"} aria-labelledby="rhythm-title">${renderWeekStrip()}<section class="rhythm-focus-grid"><section class="command-bar rhythm-money">${renderBalance(balance, archived)}${actions}</section><section class="panel rhythm-shopping"><div class="section-heading"><div><p>SHOPPING NEXT</p><h2>Possible buys</h2></div><button type="button" class="plain" data-go-view="shopping">View shopping</button></div>${homeSuggestions}</section></section>${renderRemovalUndo()}<section class="rhythm-record-grid"><section class="panel household-record"><div class="section-heading"><div><p>CHRONOLOGY</p><h2>Household record</h2></div><span>${rhythmShowAll ? "All recent purchase dates" : `Selected purchase date · ${fmt(rhythmSelectedDate)}`}</span></div>${renderHouseholdRecord()}</section></section></section><section id="view-receipts" class="ledger-view" data-dashboard-panel="receipts"${dashboardView === "receipts" ? "" : " hidden"} aria-labelledby="receipts-title"><section class="panel expenses-panel"><div class="heading"><div><p>RECEIPTS</p><h2 id="receipts-title" tabindex="-1">Recent expenses</h2></div>${receiptActions || `<span>${ledger.purchases.length} saved</span>`}</div><div class="ledger-columns" aria-hidden="true"><span>Merchant</span><span>Paid by</span><span>Date</span><span>Reviewed items</span><span>Amount</span><span>Actions</span></div><div>${purchases}</div></section></section><section id="view-shopping" class="ledger-view" data-dashboard-panel="shopping"${dashboardView === "shopping" ? "" : " hidden"} aria-labelledby="shopping-title"><section class="panel insight-card restock-panel"><div class="heading"><div><p>SHOPPING</p><h2 id="shopping-title" tabindex="-1">Possible buys</h2></div></div>${restockPanel}</section></section><section id="view-household" class="ledger-view household-view" data-dashboard-panel="household"${dashboardView === "household" ? "" : " hidden"} aria-labelledby="household-title"><div class="household-view-heading"><div><p>HOUSEHOLD</p><h2 id="household-title" tabindex="-1">People, payments and recovery</h2></div><div class="member-blocks" aria-label="Household members">${renderMembers()}</div></div><section class="panel settlements-panel"><div class="heading"><div><p>LINKED PAYMENTS</p><h2>Payment history</h2></div></div>${settlementPanel}</section>${renderSettings(balance, archived, recoveryOpen, true)}</section></section>`);
  mountDashboardNavigation();
  bindDashboard(balance);
}
function bindDashboard(balance) {
  document.querySelectorAll("[data-rhythm-date],[data-rhythm-jump]").forEach(button => button.onclick = () => {
    if (!button.dataset.rhythmDate && !button.dataset.rhythmJump) return;
    rhythmSelectedDate = button.dataset.rhythmDate || button.dataset.rhythmJump;
    rhythmShowAll = false;
    renderDashboard();
    requestAnimationFrame(() => document.querySelector(`[data-rhythm-date="${rhythmSelectedDate}"]`)?.focus());
  });
  document.querySelector("[data-show-all-history]")?.addEventListener("click", () => { rhythmShowAll = true; renderDashboard(); });
  document.querySelectorAll("[data-dashboard-view]").forEach(button => button.onclick = () => showDashboardView(button.dataset.dashboardView, true));
  document.querySelectorAll("[data-go-view]").forEach(button => button.onclick = () => showDashboardView(button.dataset.goView, true));
  document.querySelectorAll("[data-open-receipt]").forEach(button => button.onclick = () => {
    showDashboardView("receipts", true);
    const target = document.querySelector(`[data-purchase-id="${button.dataset.openReceipt}"]`);
    target?.classList.add("restock-review-target");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("add") && ($("add").onclick = () => openEntry("expense"));
  document.querySelectorAll("[data-add-expense]").forEach(button => button.onclick = () => openEntry("expense"));
  $("settle") && ($("settle").onclick = () => openEntry("settlement", { amount: (-balance).toFixed(2) }));
  $("import-pdf") && ($("import-pdf").onclick = () => $("pdf-file").click());
  document.querySelectorAll("[data-import-pdf]").forEach(button => button.onclick = () => $("pdf-file").click());
  $("open-settings") && ($("open-settings").onclick = () => {
    showDashboardView("household", true);
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
    showDashboardView("receipts", true);
    if (focusRestockReceipt(document, button.dataset.reviewRestock)) note(`Reviewing the latest receipt containing ${button.dataset.reviewName}.`);
    else note("That receipt is no longer in the active ledger. Refresh Possible buys and try again.");
  });
  document.querySelectorAll("[data-edit-receipt]").forEach(button => button.onclick = () => editReceipt(button.dataset.editReceipt));
  document.querySelectorAll("[data-delete-receipt]").forEach(button => button.onclick = () => deleteReceipt(button.dataset.deleteReceipt));
  document.querySelectorAll("[data-restore-entry]").forEach(button => button.onclick = () => restoreEntry(button.dataset.restoreEntry, button.dataset.id));
  document.querySelectorAll("[data-purge-receipt]").forEach(button => button.onclick = () => requestReceiptPurge(button.dataset.purgeReceipt));
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
  const [memberResult, purchaseResult, settlementResult, allocationResult, archivedPurchaseResult, archivedSettlementResult] = await Promise.all([
    supabase.from("household_members").select("user_id,role,display_name").eq("household_id", current.id),
    loadReviewedPurchases(supabase, current.id),
    supabase.from("receipt_backed_settlement_history").select("*").eq("household_id", current.id),
    supabase.from("settlement_allocations").select("settlement_id,purchase_id,purchase_item_id,amount"),
    loadReviewedPurchases(supabase, current.id, true),
    supabase.from("settlements").select("*").eq("household_id", current.id).not("archived_at", "is", null)
  ]);
  const error = memberResult.error || purchaseResult.error || settlementResult.error || allocationResult.error || archivedPurchaseResult.error || archivedSettlementResult.error;
  if (error) return renderLoadError("We couldn’t load the current ledger.", error.message, loadLedger);
  members = memberResult.data;
  ledger = { purchases: purchaseResult.data, settlements: settlementResult.data.filter(settlement => Number(settlement.amount) > 0), settlementAllocations: allocationResult.data, archivedPurchases: archivedPurchaseResult.data, archivedSettlements: archivedSettlementResult.data };
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
  return normalizeReviewedItem(values);
}
function reviewedItemsForSave(includeIds = false) {
  return itemsForSave(reviewedItems, includeIds);
}
function renderItemRows() {
  $("item-rows").innerHTML = renderReviewedItemRows(reviewedItems, money, expandedItemIndex);
  bindItemRows();
  updateItemTotal();
}
function bindItemRows() {
  document.querySelectorAll("[data-item]").forEach(rowElement => {
    const index = Number(rowElement.dataset.item);
    rowElement.querySelector(".edit-item").onclick = () => {
      expandedItemIndex = expandedItemIndex === index ? null : index;
      renderItemRows();
      if (expandedItemIndex === index) requestAnimationFrame(() => document.querySelector(`[data-item="${index}"] [data-field="name"]`)?.focus());
    };
    rowElement.querySelectorAll("[data-field]").forEach(input => input.oninput = () => {
      const field = input.dataset.field;
      const previousLineTotal = Number(reviewedItems[index].line_total);
      const previousSharedTotal = Number(reviewedItems[index].shared_line_total);
      const wasMerchandise = isRestockMerchandise(reviewedItems[index].name);
      reviewedItems[index][field] = input.type === "checkbox" ? input.checked : input.value;
      if (field === "line_total" && previousSharedTotal === previousLineTotal) reviewedItems[index].shared_line_total = input.value;
      if (field === "item_kind") {
        reviewedItems[index].include_in_total = input.value !== "informational";
        reviewedItems[index].unit_price = ["discount", "credit", "rounding", "informational"].includes(input.value) ? null : reviewedItems[index].unit_price;
      }
      if (field === "include_in_total" && !input.checked) reviewedItems[index].shared_line_total = 0;
      if (field === "is_personal") reviewedItems[index].shared_line_total = input.checked ? 0 : reviewedItems[index].line_total;
      reviewedItems[index].is_tracked_for_restock = reviewedItems[index].item_kind === "product" && reviewedItems[index].include_in_total && !reviewedItems[index].is_personal && isRestockMerchandise(reviewedItems[index].name) && (field === "is_tracked_for_restock" ? input.checked : reviewedItems[index].is_tracked_for_restock ?? true);
      if (field === "name") reviewedItems[index].is_tracked_for_restock = isRestockMerchandise(input.value) && (reviewedItems[index].is_tracked_for_restock || !wasMerchandise);
      if (["is_personal", "item_kind", "include_in_total"].includes(field)) renderItemRows();
      if (field === "name") { const restock = rowElement.querySelector('[data-field="is_tracked_for_restock"]'); restock.checked = reviewedItems[index].is_tracked_for_restock; restock.disabled = reviewedItems[index].is_personal || !isRestockMerchandise(input.value); }
      resetReceiptReviewConfirmation(true);
      updateItemTotal();
    });
    rowElement.querySelector(".remove-item").onclick = () => { reviewedItems.splice(index, 1); expandedItemIndex = null; resetReceiptReviewConfirmation(true); renderItemRows(); };
  });
}
function updateReceiptReviewConfirmation() {
  const count = reviewedItems.length;
  $("confirm-receipt-review").checked = receiptReviewConfirmed;
  $("confirm-receipt-review-copy").textContent = `I reviewed all ${count} ${count === 1 ? "item" : "items"} and totals.`;
}
function resetReceiptReviewConfirmation(recalculateItemSum = false) {
  receiptReviewConfirmed = false;
  $("confirm-receipt-review").checked = false;
  if (recalculateItemSum && pendingPdfImport?.amountSource === "item-sum") {
    const totals = reviewedItems.map(item => item.line_total == null || item.line_total === "" ? NaN : Number(item.line_total));
    if (totals.length && totals.every(total => Number.isFinite(total)) && totals.reduce((sum, total) => sum + total, 0) > 0) {
      $("amount").value = totals.reduce((sum, total) => sum + total, 0).toFixed(2);
    } else pendingPdfImport.amountSource = "needs-review";
  }
}
function updateItemTotal() {
  updateReceiptReviewConfirmation();
  const included = reviewedItems.filter(item => item.include_in_total !== false);
  const componentSum = kind => included.filter(item => item.item_kind === kind).reduce((total, item) => total + (Number(item.line_total) || 0), 0);
  const productSum = componentSum("product"), feeSum = componentSum("fee"), taxSum = componentSum("tax");
  const discountSum = Math.abs(componentSum("discount")), creditSum = Math.abs(componentSum("credit")), roundingSum = componentSum("rounding");
  const sum = included.reduce((total, item) => total + (Number(item.line_total) || 0), 0);
  const componentSummary = `Products: ${money(productSum)} · Fees: ${money(feeSum)} · Tax: ${money(taxSum)} · Discounts: ${money(discountSum)} · Credits: ${money(creditSum)} · Rounding: ${money(roundingSum)}`;
  const rawReceiptTotal = $("amount").value.trim();
  if (!rawReceiptTotal) {
    $("item-total").textContent = `${componentSummary} · Final total: needs confirmation · Difference unavailable`;
    return;
  }
  const receiptTotal = Number(rawReceiptTotal);
  if (!Number.isFinite(receiptTotal)) {
    $("item-total").textContent = `${componentSummary} · Final total: needs confirmation · Difference unavailable`;
    return;
  }
  const difference = receiptTotal - sum;
  const amountLabel = pendingPdfImport?.amountSource === "item-sum" ? "Calculated from item totals — verify against receipt" : pendingPdfImport?.amountSource === "edited" ? "Entered amount" : pendingPdfImport?.amountSource === "needs-review" ? "Amount to verify" : "Receipt total";
  $("item-total").textContent = `${componentSummary} · ${amountLabel}: ${money(receiptTotal)}${Math.abs(difference) > .005 ? ` · Unresolved difference: ${money(difference)}` : " · Reconciled"}`;
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
  entryInvoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (next !== "edit") editingPurchase = undefined;
  mode = next;
  pendingPdfImport = pdfImport;
  reviewedItems = (pdfImport?.items || []).map(emptyReviewedItem);
  receiptReviewConfirmed = false;
  expandedItemIndex = null;
  dialog.classList.toggle("pdf-review-dialog", !!pdfImport);
  $("dialog-title").textContent = next === "settlement" ? "Record settlement" : pdfImport ? "Review PDF import" : defaults.personal ? "Add personal expense" : "Add expense";
  $("dialog-kicker").textContent = pdfImport?.processedBy === "ai" ? "PRIVATE AI DRAFT" : pdfImport ? "LOCAL PDF DRAFT" : "NEW ENTRY";
  const parserMessage = [pdfImport?.parserWarning, pdfImport?.parserNotice].filter(Boolean).join(" ");
  const privacyMessage = pdfImport?.processedBy === "ai" ? "The original PDF and extracted text stayed local; only the approved private derivative was processed by AI." : "The PDF and extracted text remain local and are discarded when this draft closes.";
  $("dialog-help").textContent = pdfImport ? `${privacyMessage} Non-personal items are tracked for restock by default; uncheck any you do not want suggested. Review every field before saving.${parserMessage ? ` ${parserMessage}` : ""}` : "";
  $("dialog-help").classList.toggle("parser-warning", !!pdfImport?.parserWarning);
  $("expense-fields").classList.toggle("hide", next === "settlement");
  $("pdf-items").classList.toggle("hide", !pdfImport);
  $("settlement-fields").classList.toggle("hide", next !== "settlement");
  $("settlement-copy").textContent = `You are recording a payment to ${displayedMemberName(partner())}.`;
  $("label").required = next !== "settlement";
  $("label").value = defaults.label || "";
  $("category").value = defaults.category || "Groceries";
  populatePayers(defaults.paid_by || session.user.id);
  $("paid-by").disabled = false;
  $("personal").checked = !!defaults.personal;
  $("personal").disabled = !!pdfImport;
  $("amount").readOnly = false;
  $("amount").value = defaults.amount || "";
  $("date").value = defaults.date || (pdfImport ? "" : today());
  $("date-help").textContent = pdfImport && !defaults.date ? "Purchase date was not found. Choose the date printed on the receipt; upload day is not used." : pdfImport ? "Confirm this is the purchase date printed on the receipt." : "";
  $("dialog-error").textContent = "";
  const restoreDuplicate = duplicateRestoreControl();
  restoreDuplicate.classList.add("hide");
  restoreDuplicate.disabled = false;
  restoreDuplicate.onclick = null;
  $("save").disabled = false;
  $("save").textContent = "Save";
  if (pdfImport) renderItemRows();
  dialog.showModal();
  requestAnimationFrame(() => (next === "settlement" ? $("amount") : $("label")).focus());
}
function finishCloseEntry() {
  if (editingPurchase && formDirty && !pendingPdfImport && !confirm("Discard your unsaved receipt changes?")) return;
  discardPreparedVisualDerivative();
  pendingPdfImport = undefined;
  editingPurchase = undefined;
  reviewedItems = [];
  receiptReviewConfirmed = false;
  formDirty = false;
  dialog.close();
  const returnTarget = entryInvoker;
  entryInvoker = null;
  requestAnimationFrame(() => {
    if (returnTarget?.isConnected && !returnTarget.disabled) returnTarget.focus();
  });
}
function keepEditingPdfDraft() {
  discardPdfDraftDialog.close();
  requestAnimationFrame(() => $("cancel").focus());
}
function requestDiscardPdfDraft() {
  if (!pendingPdfImport) { finishCloseEntry(); return; }
  const savedEdit = mode === "edit" && editingPurchase;
  $("discard-pdf-draft-title").textContent = savedEdit ? "Discard these receipt changes?" : "Discard this receipt draft?";
  $("discard-pdf-draft-copy").textContent = savedEdit ? "Nothing was updated. Discarding will keep the saved receipt and remove only these unsaved edits." : "Nothing was saved or uploaded. Discarding will remove the local PDF and extracted receipt text from this browser.";
  discardPdfDraftDialog.showModal();
  requestAnimationFrame(() => $("keep-pdf-draft").focus());
}
function confirmDiscardPdfDraft() {
  discardPdfDraftDialog.close();
  finishCloseEntry();
}
function closeEntry() { requestDiscardPdfDraft(); }
function processedPdfImport(imported) {
  const parsed = parseReceipt(imported.pages, today());
  return withItemSumReviewAmount({
    ...imported,
    visualPlan: planVisualDerivative({ pages: imported.pages, pageSizes: imported.pageSizes, merchant: parsed.defaults.label, itemCount: parsed.items.length }),
    ...parsed
  });
}
function setImportChoiceMethod(method) {
  const ai = method === "ai";
  $("process-invoice").textContent = ai ? "Process with AI" : "Process locally";
  $("view-ai-input").classList.toggle("hide", !ai);
}
function closeImportChoice({ discard = true } = {}) {
  importChoiceDialog.close();
  $("import-choice-error").textContent = "";
  if (discard) {
    stagedPdfImport = undefined;
    stagedAiProcessed = undefined;
    discardPreparedVisualDerivative();
  }
}
function openImportChoice(imported) {
  discardPreparedVisualDerivative();
  stagedAiProcessed = undefined;
  stagedPdfImport = imported;
  $("import-choice-form").reset();
  $("import-choice-error").textContent = "";
  setImportChoiceMethod("local");
  importChoiceDialog.showModal();
  requestAnimationFrame(() => $("process-invoice").focus());
}
function showImportProcessing(method) {
  $("import-processing-title").textContent = method === "ai" ? "AI is processing the private item table" : "Processing invoice on this device";
  $("import-processing-copy").innerHTML = `${'<span class="spinner" aria-hidden="true"></span>'}${method === "ai" ? `The original PDF remains local. ${AI_EXPECTED_TIME_COPY}` : "Creating an editable local result…"}`;
  if (!importProcessingDialog.open) importProcessingDialog.showModal();
}
function closeImportProcessing() { importProcessingDialog.close(); }
function stopImportProcessing() {
  if (!confirm("Stop waiting for this invoice? Nothing will be saved.")) return;
  discardPreparedVisualDerivative();
  pendingPdfImport = undefined;
  closeImportProcessing();
  note("Invoice processing stopped. Nothing was saved.");
}
function failAiPdfImport(draftReference, message) {
  if (pendingPdfImport !== draftReference || draftReference.importProcessingMethod !== "ai") return false;
  closeImportProcessing();
  pendingPdfImport = undefined;
  showImportFeedback(`${message} Nothing was saved.`, "error");
  note(message);
  return true;
}
function startLocalPdfImport() {
  const imported = stagedPdfImport;
  if (!imported) return;
  stagedPdfImport = undefined;
  closeImportChoice({ discard: false });
  showImportProcessing("local");
  try {
    const processed = processedPdfImport(imported);
    processed.processedBy = "local";
    pendingPdfImport = processed;
    closeImportProcessing();
    openEntry("expense", processed.defaults, processed);
    note("Local invoice processing is ready for review.");
  } catch (error) {
    closeImportProcessing();
    stagedPdfImport = undefined;
    showImportFeedback(`Could not process this PDF locally: ${error.message}. Nothing was uploaded.`, "error");
  }
}
function startAiPdfImport() {
  const imported = stagedPdfImport;
  if (!imported) return;
  stagedPdfImport = undefined;
  closeImportChoice({ discard: false });
  try {
    const processed = stagedAiProcessed || processedPdfImport(imported);
    stagedAiProcessed = undefined;
    processed.importProcessingMethod = "ai";
    processed.aiStartedAt = Date.now();
    pendingPdfImport = processed;
    void prepareAi();
  } catch (error) {
    stagedPdfImport = undefined;
    showImportFeedback(`Could not prepare this PDF for AI processing locally: ${error.message}. Nothing was uploaded.`, "error");
  }
}
async function viewAiInput() {
  const imported = stagedPdfImport;
  if (!imported) return;
  const button = $("view-ai-input");
  const errorBox = $("import-choice-error");
  button.disabled = true;
  button.textContent = "Preparing local preview…";
  errorBox.textContent = "";
  try {
    const processed = stagedAiProcessed || processedPdfImport(imported);
    stagedAiProcessed = processed;
    if (processed.visualPlan && processed.sourcePdfBytes) {
      const prepared = preparedVisualDerivative?.layoutKey === processed.visualPlan.layoutKey
        ? preparedVisualDerivative
        : await createFlattenedVisualDerivative(pdfjsLib, processed.sourcePdfBytes, processed.visualPlan);
      preparedVisualDerivative = prepared;
      aiInputPreviewMode = "visual";
      closeImportChoice({ discard: false });
      openVisualAiPreview(prepared);
    } else errorBox.textContent = "A private visual item-table isolate could not be created safely. Nothing was sent. Process locally to review this invoice.";
  } catch (error) {
    errorBox.textContent = `Could not prepare a safe AI-input preview: ${error.message}. Nothing was sent or stored.`;
  } finally {
    button.disabled = false;
    button.textContent = "View what AI receives";
  }
}
viewAiInputButton.onclick = () => { void viewAiInput(); };
function discardPreparedVisualDerivative() {
  if (!preparedVisualDerivative) return;
  revokeVisualDerivativePreview(preparedVisualDerivative);
  preparedVisualDerivative = undefined;
}
function renderVisualDerivativePreview(prepared) {
  const pages = $("visual-derivative-pages");
  pages.replaceChildren(...prepared.previewUrls.map((url, index) => {
    const image = document.createElement("img");
    image.src = url;
    image.alt = `Sanitized receipt item table, page ${index + 1}`;
    return image;
  }));
}
function openVisualAiPreview(prepared) {
  $("confirm-visual-derivative").checked = false;
  $("visual-ai-preview-error").textContent = "";
  renderVisualDerivativePreview(prepared);
  $("confirm-visual-derivative").closest("label").classList.toggle("hide", aiInputPreviewMode === "visual");
  $("submit-visual-ai").textContent = aiInputPreviewMode === "visual" ? "Back to processing choices" : "Approve and send";
  visualAiPreviewDialog.showModal();
  requestAnimationFrame(() => $("confirm-visual-derivative").focus());
}
function closeVisualAiPreview({ discard = true } = {}) {
  visualAiPreviewDialog.close();
  $("visual-derivative-pages").replaceChildren();
  if (discard) discardPreparedVisualDerivative();
}
async function submitAiDerivative({ derivative, sanitizerVersion, pageCount, filename }) {
  if (!pendingPdfImport || !session?.access_token || !current?.id) throw new Error(aiParseMessage("authentication_required"));
  const draftReference = pendingPdfImport;
  const formData = new FormData();
  formData.set("derivative", derivative, filename);
  formData.set("household_id", current.id);
  draftReference.aiIdempotencyKey ||= crypto.randomUUID();
  formData.set("idempotency_key", draftReference.aiIdempotencyKey);
  formData.set("sanitizer_version", sanitizerVersion);
  formData.set("page_count", String(pageCount));
  formData.set("sanitized", "true");
  const response = await fetch(`${SUPABASE_URL}/functions/v1/sarvam-receipt-parse`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_PUBLISHABLE_KEY }, body: formData });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(aiParseMessage(result.code));
  if (!/^[0-9a-f-]{36}$/i.test(result.job_id || "")) throw new Error(aiParseMessage("invalid_provider_result"));
  if (pendingPdfImport !== draftReference) return;
  draftReference.aiJobId = result.job_id;
  if (draftReference.importProcessingMethod === "ai") showImportProcessing("ai");
  setAiProcessing("Sarvam accepted the redacted derivative and is preparing suggestions…", true);
  void pollAiReceiptResult(result.job_id, draftReference);
}
async function prepareAi() {
  const draftReference = pendingPdfImport;
  if (!draftReference) return;
  const visualPlan = draftReference.visualPlan;
  if (!visualPlan || !draftReference.sourcePdfBytes) {
    useLocalReviewAfterUnsafeVisual(draftReference);
    return;
  }
  setAiProcessing("Preparing a local visual receipt-table derivative…", true);
  try {
    const prepared = preparedVisualDerivative?.layoutKey === visualPlan.layoutKey
      ? preparedVisualDerivative
      : await createFlattenedVisualDerivative(pdfjsLib, draftReference.sourcePdfBytes, visualPlan);
    if (pendingPdfImport !== draftReference) {
      revokeVisualDerivativePreview(prepared);
      return;
    }
    preparedVisualDerivative = prepared;
    if (visualPlan.known || hasRememberedVisualLayout(prepared.layoutKey)) {
      await submitAiDerivative({ derivative: prepared.derivative, sanitizerVersion: prepared.sanitizerVersion, pageCount: prepared.pageCount, filename: "sanitized-receipt-tables.pdf" });
      discardPreparedVisualDerivative();
      return;
    }
    setAiProcessing(AI_IDLE_MESSAGE);
    openVisualAiPreview(prepared);
  } catch (error) {
    if (pendingPdfImport === draftReference) {
      discardPreparedVisualDerivative();
      useLocalReviewAfterUnsafeVisual(draftReference);
    }
  }
}
function useLocalReviewAfterUnsafeVisual(draftReference) {
  closeImportProcessing();
  draftReference.importProcessingMethod = "";
  draftReference.processedBy = "local";
  draftReference.parserWarning = [draftReference.parserWarning, "Private AI was not used because a safe visual item-table isolate could not be created. Review the local result instead."].filter(Boolean).join(" ");
  openEntry("expense", draftReference.defaults, draftReference);
  note("Nothing was sent to AI. A safe visual item-table isolate could not be created; continue with the local review.");
}
function cancelAiImport() {
  if (aiInputPreviewMode) returnToImportChoice();
  else {
  visualAiPreviewDialog.close();
  discardPreparedVisualDerivative();
  pendingPdfImport = undefined;
  note("Private AI processing cancelled. Nothing was saved; import the invoice again when you are ready.");
  }
}

function returnToImportChoice() {
  visualAiPreviewDialog.close();
  $("visual-derivative-pages").replaceChildren();
  aiInputPreviewMode = "";
  importChoiceDialog.showModal();
  requestAnimationFrame(() => $("view-ai-input").focus());
}
$("close-visual-ai-preview").onclick = cancelAiImport;
$("cancel-visual-ai-preview").onclick = cancelAiImport;
visualAiPreviewDialog.addEventListener("cancel", event => { event.preventDefault(); cancelAiImport(); });
$("visual-ai-preview-form").onsubmit = async event => {
  event.preventDefault();
  if (aiInputPreviewMode === "visual") return returnToImportChoice();
  const errorBox = $("visual-ai-preview-error");
  const button = $("submit-visual-ai");
  const prepared = preparedVisualDerivative;
  if (!prepared || !pendingPdfImport) return;
  if (!$("confirm-visual-derivative").checked) { errorBox.textContent = "Review the visual derivative and confirm it contains only the receipt item table."; return; }
  try {
    button.disabled = true;
    button.textContent = "Submitting…";
    await submitAiDerivative({ derivative: prepared.derivative, sanitizerVersion: prepared.sanitizerVersion, pageCount: prepared.pageCount, filename: "sanitized-receipt-tables.pdf" });
    rememberVisualLayout(prepared.layoutKey);
    closeVisualAiPreview();
  } catch (error) {
    errorBox.textContent = error.message || aiParseMessage();
  } finally {
    button.disabled = false;
    button.textContent = "Approve and send";
  }
};
$("close-import-choice").onclick = () => closeImportChoice();
$("cancel-import-choice").onclick = () => closeImportChoice();
importChoiceDialog.addEventListener("cancel", event => { event.preventDefault(); closeImportChoice(); });
document.querySelectorAll('input[name="processing-method"]').forEach(input => input.addEventListener("change", () => setImportChoiceMethod(input.value)));
$("import-choice-form").onsubmit = event => {
  event.preventDefault();
  const selected = document.querySelector('input[name="processing-method"]:checked');
  if (!selected) return;
  if (selected.value === "ai") startAiPdfImport();
  else startLocalPdfImport();
};
$("stop-import-processing").onclick = stopImportProcessing;
importProcessingDialog.addEventListener("cancel", event => { event.preventDefault(); stopImportProcessing(); });
function setAiProcessing(message, busy = false) {
  if (!importProcessingDialog.open && busy) showImportProcessing("ai");
  $("import-processing-copy").textContent = message;
}
async function pollAiReceiptResult(jobId, draftReference) {
  let transientFailures = 0;
  for (let attempt = 0; attempt < AI_POLL_ATTEMPTS; attempt += 1) {
    if (pendingPdfImport !== draftReference || draftReference.aiJobId !== jobId) return;
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/sarvam-receipt-result`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" }, body: JSON.stringify({ job_id: jobId, household_id: current.id }) });
      const result = await response.json().catch(() => ({}));
      const decision = aiPollDecision(response.status, result.code, transientFailures);
      if (decision.kind === "wait") {
        transientFailures = 0;
        setAiProcessing(aiProgressMessage("Private AI is reading the approved derivative.", draftReference.aiStartedAt), true);
        const seconds = Math.min(AI_MAX_RETRY_AFTER_SECONDS, Math.max(2, Number(response.headers.get("retry-after")) || 3));
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        continue;
      }
      if (decision.kind === "retry") {
        transientFailures = decision.nextFailures;
        setAiProcessing(aiProgressMessage(`Connection interrupted; retrying ${transientFailures} of 3.`, draftReference.aiStartedAt), true);
        await new Promise(resolve => setTimeout(resolve, aiRetryDelayMs(transientFailures)));
        continue;
      }
      if (decision.kind !== "complete") {
        const message = aiParseMessage(result.code);
        if (failAiPdfImport(draftReference, message)) return;
        throw new Error(message);
      }
      const aiDraft = validateAiDraft(result.draft);
      aiDraft.items = reconcileAiItemNames(aiDraft.items, draftReference.items);
      if (pendingPdfImport !== draftReference) return;
      const confirmedLocalTotal = ["high", "calculated"].includes(draftReference.totalConfidence) ? draftReference.defaults.amount : "";
      const resolvedTotal = resolveAiReceiptTotal(confirmedLocalTotal, aiDraft.defaults.amount, aiDraft.items);
      draftReference.defaults = {
        ...draftReference.defaults,
        label: aiDraft.defaults.label || draftReference.defaults.label,
        amount: resolvedTotal.amount,
        date: aiDraft.defaults.date || draftReference.defaults.date
      };
      draftReference.items = aiDraft.items;
      draftReference.processedBy = "ai";
      const unidentifiedItems = hasUnidentifiedAiItems(aiDraft.items);
      const aiNameWarning = unidentifiedItems ? "AI could not read every item name. Replace each ‘Unidentified receipt line’ before saving." : "";
      draftReference.parserWarning = [resolvedTotal.warning, aiNameWarning].filter(Boolean).join(" ");
      draftReference.parserNotice = draftReference.parserWarning ? "" : "AI processed a private receipt-table derivative. Merchant and purchase date stayed local; review every resulting item before saving.";
      draftReference.importProcessingMethod = "";
      closeImportProcessing();
      openEntry("expense", draftReference.defaults, draftReference);
      note("AI invoice processing is ready for review. Nothing was saved.");
      return;
    } catch (error) {
      const retry = aiNetworkPollDecision(transientFailures);
      if (error instanceof TypeError && retry.kind === "retry") {
        transientFailures = retry.nextFailures;
        setAiProcessing(aiProgressMessage(`Connection interrupted; retrying ${transientFailures} of 3.`, draftReference.aiStartedAt), true);
        await new Promise(resolve => setTimeout(resolve, aiRetryDelayMs(transientFailures)));
        continue;
      }
      if (pendingPdfImport === draftReference) {
        const message = error.message || aiParseMessage();
        if (failAiPdfImport(draftReference, message)) return;
        setAiProcessing(`${message} Continue reviewing or save the local draft.`);
      }
      return;
    }
  }
  if (pendingPdfImport === draftReference) {
    const message = aiParseMessage("completion_timeout");
    if (failAiPdfImport(draftReference, message)) return;
    setAiProcessing(`${message} Continue reviewing or save the local draft.`);
  }
}
function validateAiDraft(draft) {
  if (!draft || typeof draft !== "object" || !draft.defaults || !Array.isArray(draft.items) || !draft.items.length || draft.items.length > 100) throw new Error(aiParseMessage("invalid_provider_result"));
  const label = String(draft.defaults.label || "").trim().slice(0, 160);
  const amount = Number(draft.defaults.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(aiParseMessage("invalid_provider_result"));
  const items = draft.items.map(item => emptyReviewedItem(item));
  if (items.some(item => !item.name.trim() || !Number.isFinite(Number(item.line_total)) || Number(item.line_total) < 0)) throw new Error(aiParseMessage("invalid_provider_result"));
  if (Math.abs(items.reduce((sum, item) => sum + Number(item.line_total), 0) - amount) > .01) throw new Error(aiParseMessage("invalid_provider_result"));
  return { defaults: { label, amount: amount.toFixed(2), date: /^\d{4}-\d{2}-\d{2}$/.test(draft.defaults.date || "") ? draft.defaults.date : "" }, items };
}
$("close").onclick = closeEntry;
$("cancel").onclick = closeEntry;
dialog.addEventListener("cancel", event => { event.preventDefault(); closeEntry(); });
dialog.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !dialog.open) return;
  event.preventDefault();
  event.stopPropagation();
  closeEntry();
});
$("keep-pdf-draft").onclick = keepEditingPdfDraft;
$("confirm-discard-pdf-draft").onclick = confirmDiscardPdfDraft;
discardPdfDraftDialog.addEventListener("cancel", event => { event.preventDefault(); keepEditingPdfDraft(); });
discardPdfDraftDialog.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !discardPdfDraftDialog.open) return;
  event.preventDefault();
  event.stopPropagation();
  keepEditingPdfDraft();
});
$("keep-receipt").onclick = keepReceipt;
$("confirm-remove-receipt").onclick = confirmRemoveReceipt;
$("remove-receipt").addEventListener("cancel", event => { event.preventDefault(); keepReceipt(); });
$("remove-receipt").addEventListener("click", event => { if (event.target === $("remove-receipt")) keepReceipt(); });
$("keep-removed-receipt").onclick = keepRemovedReceipt;
$("confirm-purge-receipt").onclick = confirmReceiptPurge;
$("purge-receipt").addEventListener("cancel", event => { event.preventDefault(); keepRemovedReceipt(); });
$("purge-receipt").addEventListener("click", event => { if (event.target === $("purge-receipt")) keepRemovedReceipt(); });
$("add-item").onclick = () => { reviewedItems.push(emptyReviewedItem()); resetReceiptReviewConfirmation(true); renderItemRows(); };
$("confirm-receipt-review").onchange = event => { receiptReviewConfirmed = event.currentTarget.checked; };
$("amount").oninput = () => { if (pendingPdfImport) pendingPdfImport.amountSource = "edited"; resetReceiptReviewConfirmation(); updateItemTotal(); };
["label", "category", "paid-by", "date"].forEach(id => $(id).addEventListener("change", () => {
  if (mode === "edit" && editingPurchase?.purchase_items?.length) resetReceiptReviewConfirmation();
}));
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
    const allocations = settlementAllocations(receiver.user_id, amount, $("date").value);
    if (!allocations.length) { errorBox.textContent = "This payment cannot be matched to enough active shared receipt balance on or before this date. Check the amount and date, or restore the supporting receipt first."; button.disabled = false; button.textContent = "Save"; return; }
    const payer = displayedMemberName(members.find(member => member.user_id === session.user.id));
    const receiverName = displayedMemberName(receiver);
    if (!confirm(settlementConfirmation(payer, receiverName, amount, $("date").value))) { button.disabled = false; button.textContent = "Save"; return; }
    ({ error } = await supabase.rpc("record_receipt_backed_settlement", { p_household_id: current.id, p_receiver: receiver.user_id, p_amount: amount, p_settled_on: $("date").value, p_allocations: allocations }));
  } else {
    const label = $("label").value.trim();
    if (!label) { errorBox.textContent = "Add a merchant or description."; button.disabled = false; button.textContent = "Save"; return; }
    const paidBy = $("paid-by").value;
    if (!members.some(member => member.user_id === paidBy)) { errorBox.textContent = "Choose a current household member who paid this expense."; button.disabled = false; button.textContent = "Save"; return; }
    const personal = $("personal").checked;
    if (!personal && !hasPartner()) { errorBox.textContent = "Your partner must join before saving a shared expense."; button.disabled = false; button.textContent = "Save"; return; }
    if (mode === "edit" && editingPurchase) {
      if (editingPurchase.purchase_items?.length) {
        if (!receiptReviewConfirmed) { errorBox.textContent = "Confirm that you reviewed all items and totals before updating this receipt."; $("confirm-receipt-review").focus(); button.disabled = false; button.textContent = "Update receipt"; return; }
        const items = reviewedItemsForSave(true);
        if (!items.length || items.some(item => !item.name || item.line_total == null)) { errorBox.textContent = "Every reviewed item needs a name and line total."; button.disabled = false; button.textContent = "Update receipt"; return; }
        if (items.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0)) { errorBox.textContent = "Every item quantity must be above zero."; button.disabled = false; button.textContent = "Update receipt"; return; }
        if (items.some(item => item.unit_price != null && (!Number.isFinite(item.unit_price) || item.unit_price < 0))) { errorBox.textContent = "Unit prices cannot be negative."; button.disabled = false; button.textContent = "Update receipt"; return; }
        if (items.some(item => ["product", "fee", "tax"].includes(item.item_kind) ? !(item.line_total > 0) : ["discount", "credit"].includes(item.item_kind) ? !(item.line_total < 0) : item.item_kind === "rounding" ? !item.line_total || Math.abs(item.line_total) > 1 : item.item_kind === "informational" && item.include_in_total)) { errorBox.textContent = "Check component signs: products, fees, and additive tax are positive; discounts and credits are negative; rounding is non-zero within ₹1; information-only lines stay outside the total."; button.disabled = false; button.textContent = "Update receipt"; return; }
        if (items.some(item => !Number.isFinite(item.shared_line_total) || (item.line_total >= 0 ? item.shared_line_total < 0 || item.shared_line_total > item.line_total : item.shared_line_total < item.line_total || item.shared_line_total > 0))) { errorBox.textContent = "Each shared effect must be between zero and its signed line total."; button.disabled = false; button.textContent = "Update receipt"; return; }
        const reviewedTotal = items.filter(item => item.include_in_total).reduce((total, item) => total + (item.line_total || 0), 0);
        if (Math.abs(reviewedTotal - amount) > .01) { errorBox.textContent = "Products, fees, taxes, discounts, and rounding must reconcile to the final order total within ₹0.01. Product prices were not adjusted; resolve the displayed difference, then review again."; button.disabled = false; button.textContent = "Update receipt"; return; }
        ({ error } = await updateReviewedPurchase(supabase, { p_purchase_id: editingPurchase.id, p_label: label, p_category: $("category").value, p_purchased_on: $("date").value, p_items: items }));
      } else {
        const changes = receiptEditChanges(editingPurchase, { label, category: $("category").value, paidBy, purchasedOn: $("date").value, amount, personal });
        let request = supabase.from("purchases").update(changes).eq("id", editingPurchase.id).eq("household_id", current.id);
        if (!isOwner()) request = request.eq("paid_by", session.user.id);
        const result = await request.select("id").maybeSingle();
        error = result.error || (!result.data ? { message: "This receipt can only be edited by its payer or the household owner." } : undefined);
      }
    } else if (pendingPdfImport) {
      if (!receiptReviewConfirmed) { errorBox.textContent = "Confirm that you reviewed all items and totals before saving this receipt."; $("confirm-receipt-review").focus(); button.disabled = false; button.textContent = "Save"; return; }
      const items = reviewedItemsForSave();
      if (!items.length || items.some(item => !item.name)) { errorBox.textContent = "Every reviewed item needs a name."; button.disabled = false; button.textContent = "Save"; return; }
      if (hasUnidentifiedAiItems(items)) { errorBox.textContent = "Replace every ‘Unidentified receipt line’ with the item name before saving."; button.disabled = false; button.textContent = "Save"; return; }
      if (items.some(item => item.line_total == null)) { errorBox.textContent = "Every reviewed item needs a line total."; button.disabled = false; button.textContent = "Save"; return; }
      if (items.some(item => item.quantity != null && (!Number.isFinite(item.quantity) || item.quantity <= 0))) { errorBox.textContent = "Item quantities must be above zero."; button.disabled = false; button.textContent = "Save"; return; }
      if (items.some(item => item.unit_price != null && (!Number.isFinite(item.unit_price) || item.unit_price < 0))) { errorBox.textContent = "Unit prices cannot be negative."; button.disabled = false; button.textContent = "Save"; return; }
      if (items.some(item => ["product", "fee", "tax"].includes(item.item_kind) ? !(item.line_total > 0) : ["discount", "credit"].includes(item.item_kind) ? !(item.line_total < 0) : item.item_kind === "rounding" ? !item.line_total || Math.abs(item.line_total) > 1 : item.item_kind === "informational" && item.include_in_total)) { errorBox.textContent = "Check component signs: products, fees, and additive tax are positive; discounts and credits are negative; rounding is non-zero within ₹1; information-only lines stay outside the total."; button.disabled = false; button.textContent = "Save"; return; }
      if (items.some(item => !Number.isFinite(item.shared_line_total) || (item.line_total >= 0 ? item.shared_line_total < 0 || item.shared_line_total > item.line_total : item.shared_line_total < item.line_total || item.shared_line_total > 0))) { errorBox.textContent = "Each shared effect must be between zero and its signed line total."; button.disabled = false; button.textContent = "Save"; return; }
      const reviewedTotal = items.filter(item => item.include_in_total).reduce((total, item) => total + (item.line_total || 0), 0);
      if (Math.abs(reviewedTotal - amount) > .01) { errorBox.textContent = "Products, fees, taxes, discounts, and rounding must reconcile to the final order total within ₹0.01. Product prices were not adjusted; resolve the displayed difference, then review again."; button.disabled = false; button.textContent = "Save"; return; }
      const allPersonal = items.every(item => !item.include_in_total || Number(item.shared_line_total) === 0);
      ({ error } = await importReviewedPurchase(supabase, { p_household_id: current.id, p_paid_by: paidBy, p_exact_pdf_hash: pendingPdfImport.exactHash, p_content_hash: pendingPdfImport.contentHash, p_content_hash_reliable: pendingPdfImport.contentHashReliable !== false, p_label: label, p_category: $("category").value, p_amount: amount, p_purchased_on: $("date").value, p_is_personal: allPersonal, p_items: items }));
    } else {
      ({ error } = await supabase.from("purchases").insert({ household_id: current.id, label, category: $("category").value, amount, paid_by: paidBy, purchased_on: $("date").value, is_personal: personal, is_tracked_for_restock: false, estimated_use_by: null }));
    }
  }
  if (error) {
    if (pendingPdfImport && mode !== "edit" && isDuplicateImportError(error)) {
      const lookup = await findInvoiceDuplicate(pendingPdfImport);
      const result = lookup.error || duplicateState(lookup.result) === "none" ? { duplicate_status: "ambiguous" } : lookup.result;
      const duplicateMessage = duplicateImportMessage(result);
      lastPdfFeedback = { exactHash: pendingPdfImport.exactHash, contentHash: pendingPdfImport.contentHash, contentHashReliable: pendingPdfImport.contentHashReliable, message: duplicateMessage, result };
      errorBox.textContent = duplicateMessage;
      errorBox.tabIndex = -1;
      errorBox.focus();
      note("");
      const restoreButton = duplicateRestoreControl();
      const existing = duplicatePurchase(result);
      const restoreId = isExactDuplicate(result) ? restorableDuplicatePurchaseId(result) : null;
      const orphaned = duplicateState(result) === "legacy_unlinked";
      restoreButton.classList.toggle("hide", !restoreId && !orphaned);
      restoreButton.textContent = restoreId ? "Restore removed receipt" : "Check and retry import";
      restoreButton.setAttribute("aria-label", restoreId ? `Restore ${existing?.label || "removed receipt"} to the ledger` : orphaned ? "Ask the ledger to verify and release this orphaned import reservation" : "");
      restoreButton.onclick = restoreId ? async () => {
        restoreButton.disabled = true;
        if (await restoreRemovedReceipt(restoreId, "duplicate")) {
          discardPreparedVisualDerivative();
          pendingPdfImport = undefined;
          reviewedItems = [];
          receiptReviewConfirmed = false;
          formDirty = false;
          dialog.close();
        } else restoreButton.disabled = false;
      } : orphaned ? async () => {
        restoreButton.disabled = true;
        const release = await releaseOrphanedImport(pendingPdfImport);
        if (release.error || !release.released) { errorBox.textContent = `This reservation could not be released safely. ${release.error?.message || "The database did not approve it."}`; restoreButton.disabled = false; return; }
        lastPdfFeedback = undefined;
        restoreButton.classList.add("hide");
        errorBox.textContent = "The orphaned reservation was released. Review the draft, then save again.";
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
  discardPreparedVisualDerivative();
  pendingPdfImport = undefined;
  editingPurchase = undefined;
  reviewedItems = [];
  receiptReviewConfirmed = false;
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
function keepRemovedReceipt() {
  pendingReceiptPurgeId = undefined;
  $("purge-receipt-error").textContent = "";
  $("purge-receipt").close();
}
function requestReceiptPurge(id) {
  const purchase = ledger.archivedPurchases.find(item => item.id === id);
  if (!purchase || !active() || !isOwner()) return;
  pendingReceiptPurgeId = id;
  $("purge-receipt-name").textContent = purchase.label;
  $("purge-receipt-error").textContent = "";
  $("purge-receipt").showModal();
  requestAnimationFrame(() => $("keep-removed-receipt").focus());
}
async function confirmReceiptPurge() {
  const id = pendingReceiptPurgeId;
  if (!id || !isOwner()) return;
  const button = $("confirm-purge-receipt");
  button.disabled = true;
  button.textContent = "Deleting…";
  const { error } = await supabase.rpc("purge_purchase_receipt", { p_purchase_id: id });
  button.disabled = false;
  button.textContent = "Delete permanently";
  if (error) { $("purge-receipt-error").textContent = error.message; return; }
  forgetRemovedReceipt(sessionStorage, id);
  lastPdfFeedback = undefined;
  clearImportFeedback(document);
  pendingReceiptPurgeId = undefined;
  $("purge-receipt").close();
  note("Receipt permanently deleted.");
  await loadLedger();
}
function keepReceipt() {
  pendingReceiptRemovalId = undefined;
  $("remove-receipt-error").textContent = "";
  $("remove-receipt").close();
}
function deleteReceipt(id) {
  const purchase = ledger.purchases.find(item => item.id === id);
  if (!purchase) return;
  pendingReceiptRemovalId = id;
  $("remove-receipt-error").textContent = "";
  $("remove-receipt").showModal();
  requestAnimationFrame(() => $("keep-receipt").focus());
}
async function confirmRemoveReceipt() {
  const id = pendingReceiptRemovalId;
  if (!id) return;
  const button = $("confirm-remove-receipt");
  button.disabled = true;
  button.textContent = "Removing…";
  const { error } = await supabase.rpc("delete_purchase_receipt", { p_purchase_id: id });
  button.disabled = false;
  button.textContent = "Remove receipt";
  if (error) { $("remove-receipt-error").textContent = error.message; return; }
  rememberRemovedReceipt(sessionStorage, current.id, session.user.id, id);
  pendingReceiptRemovalId = undefined;
  $("remove-receipt").close();
  note("Receipt removed from the ledger. It remains restorable.");
  await loadLedger();
}
function editReceipt(id) {
  const purchase = ledger.purchases.find(item => item.id === id);
  if (!canManageReceipt(purchase, session.user.id, isOwner(), active())) return;
  editingPurchase = purchase;
  const itemized = !!purchase.purchase_items?.length;
  const savedItems = itemized ? savedPurchaseItemsForReview(purchase.purchase_items) : [];
  openEntry("edit", { label: purchase.label, category: purchase.category, paid_by: purchase.paid_by, amount: purchase.amount, date: purchase.purchased_on, personal: purchase.is_personal }, itemized ? { items: savedItems, amountSource: "item-sum", savedEdit: true } : undefined);
  editingPurchase = purchase;
  $("dialog-kicker").textContent = "SAVED RECEIPT";
  $("dialog-title").textContent = "Edit receipt";
  $("dialog-help").textContent = itemized ? "Review every saved item before updating. Products, paid fees, tax, discounts, and rounding must reconcile to the final order total. Personal lines stay out of the shared balance; only eligible merchandise can be tracked for restock. Paid by stays fixed to preserve the receipt and settlement audit trail." : "Update this manual receipt entry. Changes recalculate the shared ledger immediately.";
  $("amount").readOnly = itemized;
  $("paid-by").disabled = itemized;
  $("personal").disabled = itemized;
  $("save").textContent = "Update receipt";
  formDirty = false;
}
async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function readPdfLocally(file) {
  const sourcePdfBytes = new Uint8Array(await file.arrayBuffer());
  const exactHash = await sha256(sourcePdfBytes);
  const pdf = await pdfjsLib.getDocument({ data: sourcePdfBytes.slice() }).promise;
  const pages = [];
  const pageSizes = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    note(`Reading page ${pageNumber} of ${pdf.numPages} locally…`);
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    pageSizes.push({ width: viewport.width, height: viewport.height });
    const content = await page.getTextContent();
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
  return {
    exactHash,
    contentHash: await sha256(normalized),
    contentHashReliable: contentFingerprintIsReliable(normalized),
    sourcePdfBytes,
    pageSizes,
    pages
  };
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
    if (sameFingerprint(imported, pendingPdfImport) || sameFingerprint(imported, stagedPdfImport)) {
      const message = "This receipt is already being prepared. Continue with it or close the current import before choosing another file.";
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
    openImportChoice(imported);
    note("Choose how to process this invoice. Nothing has been added to the ledger.");
  } catch (error) {
    showImportFeedback(`Could not read this PDF locally: ${error.message}. Nothing was uploaded. Choose the file again to retry.`, "error");
  } finally {
    input.value = "";
    setPdfBusy(false);
  }
};

function unsafeForRefresh() {
  return hasUnsafeDraft({ dialogOpen: dialog.open || importChoiceDialog.open || importProcessingDialog.open, pendingPdfImport: pendingPdfImport || stagedPdfImport, formDirty });
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
