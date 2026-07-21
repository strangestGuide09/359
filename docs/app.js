import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";
import { classifySignInError } from "./auth-errors.js";
import { isDuplicateImportError, sameFingerprint } from "./duplicate-import.js";
import { clearImportFeedback, showImportFeedback as renderImportFeedback } from "./import-feedback.js";
import { parseReceipt } from "./receipt-parser.js";
import { qualifiesForRestockSuggestion, restockHistory } from "./restock.js";
import { hasUnsafeDraft, versionAction } from "./version-check.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.localStorage }
});
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const money = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(n) || 0);
const fmt = d => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d}T12:00:00`));
const esc = text => String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const retryKey = "grocery-ledger-email-retry-at";
const dialog = $("entry");
const clientBuild = window.GROCERY_LEDGER_BUILD || "local-dev";
const reloadVersionKey = "grocery-ledger-reloading-version";

let session;
let current;
let members = [];
let ledger = { purchases: [], settlements: [], archivedPurchases: [], archivedSettlements: [] };
let channel;
let mode = "expense";
let pendingPdfImport;
let reviewedItems = [];
let lastPdfFeedback;
let formDirty = false;

document.addEventListener("input", event => { if (event.target.closest?.("form")) formDirty = true; });
document.addEventListener("change", event => { if (event.target.closest?.("form")) formDirty = true; });

function note(text) { $("status").textContent = text || ""; }
function showImportFeedback(message, kind = "info") { renderImportFeedback(document, message, kind); }
function matchingPurchase(importedAt) {
  const importedTime = Date.parse(importedAt);
  return [...ledger.purchases, ...ledger.archivedPurchases]
    .map(purchase => ({ purchase, distance: Math.abs(Date.parse(purchase.created_at) - importedTime) }))
    .filter(candidate => Number.isFinite(candidate.distance) && candidate.distance < 15000)
    .sort((a, b) => a.distance - b.distance)[0]?.purchase;
}
function duplicateImportMessage(importRecord, fallbackPurchase) {
  const existing = matchingPurchase(importRecord?.imported_at) || fallbackPurchase;
  const identity = existing ? ` as ${existing.label} from ${fmt(existing.purchased_on)}${existing.archived_at ? " (archived)" : ""}` : importRecord?.imported_at ? ` on ${fmt(importRecord.imported_at.slice(0, 10))}` : "";
  return `This receipt was already imported${identity}. No new expense was added. Review Expenses or archived entries instead.`;
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
function memberName(id) {
  const member = members.find(candidate => candidate.user_id === id);
  const name = memberDisplayName(member);
  return id === session?.user?.id ? `${name} (you)` : name;
}
function payerName(member) {
  const role = member.role === "owner" ? "Owner" : "Partner";
  return `${memberDisplayName(member)} (${member.user_id === session?.user?.id ? "you · " : ""}${role})`;
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
function renderLoadError(title, detail, retry) {
  $("sync-state").textContent = "Could not sync";
  setScreen(statePanel("CONNECTION PROBLEM", esc(title), `${esc(detail)} Your balance is hidden until current ledger data loads.`, `<button id="retry-load">Try again</button>`));
  $("retry-load").onclick = retry;
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
  const canManage = own || isOwner();
  const heading = type === "purchase" ? esc(item.label) : `${esc(memberName(item.payer))} paid ${esc(memberName(item.receiver))}`;
  const count = type === "purchase" && item.purchase_items?.length ? ` · ${item.purchase_items.length} reviewed item${item.purchase_items.length === 1 ? "" : "s"}` : "";
  const sub = type === "purchase" ? `${esc(item.category)} · paid by ${esc(memberName(item.paid_by))} · ${fmt(item.purchased_on)}${item.is_personal ? " · personal" : ""}${count}` : fmt(item.settled_on);
  return `<div class="expense"><div><b>${heading}</b><span>${sub}</span></div><div class="entry-actions"><b>${money(item.amount)}</b>${canManage && active() ? `<button class="plain action" data-archive="${type}" data-id="${item.id}">Archive</button>` : ""}</div></div>`;
}
function suggestions() {
  const groups = restockHistory(ledger.purchases);
  const cards = [...groups.values()].map(items => {
    items.sort((a, b) => a.purchased_on.localeCompare(b.purchased_on));
    const dates = [...new Set(items.map(item => item.purchased_on))];
    if (!qualifiesForRestockSuggestion(items)) return null;
    const [previous, last] = dates.slice(-2);
    const days = Math.max(1, Math.round((Date.parse(`${last}T12:00:00`) - Date.parse(`${previous}T12:00:00`)) / 86400000));
    const latest = items.at(-1);
    const due = latest.estimated_use_by || new Date(Date.parse(`${last}T12:00:00`) + days * 86400000).toISOString().slice(0, 10);
    return `<div class="suggestion"><div><b>${esc(latest.display_name)}</b><span>${latest.estimated_use_by ? "Reviewed use-by" : `Latest interval: ${days} days`} · bought ${dates.length} times</span></div><time class="${due <= today() ? "due" : ""}">${due <= today() ? "Review now" : `Around ${fmt(due)}`}</time></div>`;
  }).filter(Boolean);
  if (cards.length) return cards.join("");
  return groups.size ? `<p class="empty-state">Tracking ${groups.size} item${groups.size === 1 ? "" : "s"}. Buy a tracked item again on another date to see a suggestion.</p>` : '<p class="empty-state">No tracked grocery items yet. Import a receipt and keep “Track for restock” selected.</p>';
}

function renderSignedOut(authMode = "signin") {
  $("sync-state").textContent = "Sign in required";
  const creating = authMode === "signup";
  const retryAt = Number(localStorage.getItem(retryKey) || 0);
  const waiting = retryAt > Date.now();
  const time = new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  setScreen(`<section class="panel account-gate"><p>WELCOME</p><h1 tabindex="-1">Grocery Ledger</h1><article>${creating ? "Create your account with your name and email." : "Sign in to your existing account."} We’ll email a secure one-time link; open it in this same laptop browser.</article><div class="auth-choice" aria-label="Account access"><button id="show-signin" type="button" class="${creating ? "secondary" : ""}" aria-pressed="${!creating}">Sign in</button><button id="show-signup" type="button" class="${creating ? "" : "secondary"}" aria-pressed="${creating}">Create account</button></div><form id="login-form" class="auth-form${creating ? " auth-signup" : ""}">${creating ? '<label>Your name<input id="signup-name" maxlength="80" required autocomplete="name" placeholder="e.g. Ekta"></label>' : ""}<label>Email<input id="login-email" type="email" required autocomplete="email" placeholder="you@example.com"></label><button${waiting ? " disabled" : ""}>${waiting ? `Try again at ${time}` : creating ? "Create account" : "Send sign-in link"}</button></form><p id="auth-status" class="auth-status${waiting ? " error" : ""}">${waiting ? `Try again at ${time}.` : creating ? "Your name is shared only with your household partner." : "Sign in will not create a new account."}</p></section>`);
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
    const options = { emailRedirectTo: `${location.origin}${location.pathname}${location.search}`, shouldCreateUser: creating };
    if (creating) options.data = { display_name: displayName };
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
    $("auth-status").className = "auth-status success";
    $("auth-status").textContent = `${creating ? "Account link" : "Sign-in link"} sent to ${email}. Check Inbox and Spam, then open the newest link in this browser.`;
    button.disabled = false;
    button.textContent = "Send another link";
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
  $("sign-out").onclick = () => supabase.auth.signOut();
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
  $("sign-out").onclick = () => supabase.auth.signOut();
}
function renderPartnerInvite() {
  $("sync-state").textContent = "Waiting for partner";
  setScreen(`<section class="panel account-gate partner-gate"><p>HOUSEHOLD CREATED</p><h1 tabindex="-1">Invite your partner</h1><article>${esc(current.name)} becomes a shared ledger after your partner joins. Shared expenses, balances, settlements, and restock history stay locked until then.</article><div class="invite-box"><h2>Send a one-time invite</h2><p>Create a new invite link, then send it privately to your partner. They can also paste the code shown in the link.</p><div class="settings-actions"><button id="copy-invite">Copy invite link</button><button id="email-invite" class="secondary">Email invite</button></div></div><div class="settings-actions"><button id="add-personal" class="secondary">Add personal expense</button><button id="refresh-partner" class="plain">Check if partner joined</button><button id="sign-out" class="plain">Sign out</button></div></section>`);
  $("copy-invite").onclick = () => shareInvite("copy");
  $("email-invite").onclick = () => shareInvite("email");
  $("add-personal").onclick = () => openEntry("expense", { personal: true });
  $("refresh-partner").onclick = loadLedger;
  $("sign-out").onclick = () => supabase.auth.signOut();
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
function renderDashboard() {
  const balance = balanceFor(session.user.id);
  const archived = !!current.archived_at;
  const otherName = memberDisplayName(partner());
  $("sync-state").textContent = archived ? "Archived · read only" : "Synced";
  const purchases = [...ledger.purchases].sort((a, b) => b.purchased_on.localeCompare(a.purchased_on)).map(item => row(item, "purchase")).join("") || '<p class="empty-state">No shared expenses yet. Add one or import a receipt to begin.</p>';
  const settlements = [...ledger.settlements].sort((a, b) => b.settled_on.localeCompare(a.settled_on)).map(item => row(item, "settlement")).join("") || '<p class="empty-state">No settlements recorded.</p>';
  const restock = suggestions();
  const balanceText = Math.abs(balance) < .005 ? `You and ${esc(otherName)} are settled` : balance > 0 ? `${esc(otherName)} owes you ${money(balance)}` : `You owe ${esc(otherName)} ${money(-balance)}`;
  const recoveryOpen = archived && new Date(current.purge_after) > new Date();
  const ownerControls = isOwner() ? archived ? `<div class="danger-zone">${recoveryOpen ? `<button id="restore-household" class="secondary">Restore household</button><small>Recovery is available until ${fmt(current.purge_after)}.</small>` : `<button id="delete-household" class="danger">Permanently delete</button><small>The 30-day recovery period has ended.</small>`}</div>` : `<div class="danger-zone"><b>Close household</b><small>${Math.abs(balance) >= .005 ? "Settle the balance before closing." : "Starts a 30-day recovery period."}</small><button id="archive-household" class="danger"${Math.abs(balance) >= .005 ? " disabled" : ""}>Close household</button></div>` : "";
  const archivedEntries = [...ledger.archivedPurchases.map(item => ({ ...item, type: "purchase" })), ...ledger.archivedSettlements.map(item => ({ ...item, type: "settlement" }))];
  const memberSummary = members.map(member => `<span class="member-chip"><b>${esc(memberDisplayName(member))}</b><small>${member.role === "owner" ? "Owner" : "Partner"}${member.user_id === session.user.id ? " · you" : ""}</small></span>`).join("");
  const actions = archived ? "" : `<nav class="primary-actions" aria-label="Ledger actions"><button id="import-pdf">Import receipt</button><button id="add" class="secondary">Add expense</button>${balance < -.005 ? `<button id="settle" class="secondary">Settle ${money(-balance)}</button>` : ""}</nav>`;
  setScreen(`<section class="dashboard-head"><div class="household-title"><p>HOUSEHOLD</p><h1 tabindex="-1">${esc(current.name)}</h1><div class="member-chips">${memberSummary}</div></div><aside class="balance-card"><small>Current balance</small><strong>${balanceText}</strong><span>Shared items split equally</span></aside>${actions}<details class="privacy-disclosure"><summary>Privacy: only reviewed receipt items sync</summary><p>PDFs and extracted text stay in this browser session. Payment methods, addresses, card and UPI details are never saved.</p></details>${archived ? `<p class="archive-banner">This household is archived and read-only. ${recoveryOpen ? `It can be restored until ${fmt(current.purge_after)}.` : "Its recovery period has ended."}</p>` : ""}</section><section class="dashboard-grid"><section class="dashboard-main"><section class="panel activity expenses-panel"><div class="heading"><div><p>LEDGER</p><h2>Expenses</h2></div><span>${ledger.purchases.length} saved</span></div><div>${purchases}</div></section></section><aside class="dashboard-side"><section class="panel compact-card"><div class="heading"><div><p>RESTOCK</p><h2>Possible buys</h2></div></div><div>${restock}</div></section><section class="panel compact-card"><div class="heading"><div><p>SETTLEMENTS</p><h2>Payment history</h2></div></div><div>${settlements}</div></section></aside></section><details class="panel settings"><summary><span><b>Household settings</b><small>Names, archived entries and recovery</small></span><span aria-hidden="true">Open</span></summary><div class="settings-body"><div class="member-list">${members.map(member => `<div class="expense"><div><b>${esc(memberDisplayName(member))}</b><span>${member.role === "owner" ? "Owner" : "Partner"}${member.user_id === session.user.id ? " · you" : ""}</span></div></div>`).join("")}</div>${archived ? "" : `<form id="display-name-form" class="inline-form"><label>Your display name<input id="display-name" maxlength="80" required autocomplete="name" value="${esc(memberDisplayName(members.find(member => member.user_id === session.user.id)))}"></label><button class="secondary">Update name</button></form>`}${archivedEntries.length ? `<details class="archive-list"><summary>Archived entries (${archivedEntries.length})</summary>${archivedEntries.map(item => `<div class="expense"><div><b>${item.type === "purchase" ? esc(item.label) : "Archived settlement"}</b><span>${money(item.amount)}</span></div>${active() && (isOwner() || (item.type === "purchase" ? item.paid_by : item.payer) === session.user.id) ? `<button class="secondary" data-restore-entry="${item.type}" data-id="${item.id}">Restore</button>` : ""}</div>`).join("")}</details>` : ""}${ownerControls}<div class="settings-actions"><button id="sign-out" class="plain">Sign out</button></div></div></details>`);
  bindDashboard(balance);
}
function bindDashboard(balance) {
  $("add") && ($("add").onclick = () => openEntry("expense"));
  $("settle") && ($("settle").onclick = () => openEntry("settlement", { amount: (-balance).toFixed(2) }));
  $("import-pdf") && ($("import-pdf").onclick = () => $("pdf-file").click());
  $("sign-out").onclick = () => supabase.auth.signOut();
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
  document.querySelectorAll("[data-restore-entry]").forEach(button => button.onclick = () => restoreEntry(button.dataset.restoreEntry, button.dataset.id));
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
  return { name: values.name || "", quantity: values.quantity ?? 1, unit: values.unit || "", unit_price: values.unit_price ?? null, line_total: values.line_total ?? null, is_personal: personal, is_tracked_for_restock: personal ? false : values.is_tracked_for_restock ?? true, estimated_use_by: values.estimated_use_by || "" };
}
function renderItemRows() {
  $("item-rows").innerHTML = reviewedItems.map((item, index) => `<fieldset class="item-row" data-item="${index}"><legend>Item ${index + 1}</legend><div class="item-primary"><label class="item-name">Item name<input data-field="name" maxlength="160" value="${esc(item.name)}" required></label><label>Qty<input data-field="quantity" inputmode="decimal" value="${item.quantity ?? ""}" placeholder="1"></label><label>Line total (₹)<input data-field="line_total" inputmode="decimal" value="${item.line_total ?? ""}" placeholder="0.00"></label></div><div class="item-flags"><label class="check"><input data-field="is_personal" type="checkbox"${item.is_personal ? " checked" : ""}> Personal</label><label class="check"><input data-field="is_tracked_for_restock" type="checkbox"${item.is_tracked_for_restock ? " checked" : ""}${item.is_personal ? " disabled" : ""}> Track for restock</label><details class="item-details"><summary>More details</summary><div><label>Unit<input data-field="unit" maxlength="30" value="${esc(item.unit)}" placeholder="e.g. kg"></label><label>Unit price (₹)<input data-field="unit_price" inputmode="decimal" value="${item.unit_price ?? ""}" placeholder="0.00"></label><label>Use-by (optional)<input data-field="estimated_use_by" type="date" value="${item.estimated_use_by}"></label><button type="button" class="plain remove-item"${reviewedItems.length === 1 ? " disabled" : ""}>Remove item</button></div></details></div></fieldset>`).join("");
  bindItemRows();
  updateItemTotal();
}
function bindItemRows() {
  document.querySelectorAll("[data-item]").forEach(rowElement => {
    const index = Number(rowElement.dataset.item);
    rowElement.querySelectorAll("[data-field]").forEach(input => input.oninput = () => {
      const field = input.dataset.field;
      reviewedItems[index][field] = input.type === "checkbox" ? input.checked : input.value;
      if (field === "is_personal") reviewedItems[index].is_tracked_for_restock = !input.checked;
      if (field === "is_personal") renderItemRows();
      updateItemTotal();
    });
    rowElement.querySelector(".remove-item").onclick = () => { reviewedItems.splice(index, 1); renderItemRows(); };
  });
}
function updateItemTotal() {
  const sum = reviewedItems.reduce((total, item) => total + (Number(item.line_total) || 0), 0);
  const receiptTotal = Number($("amount").value) || 0;
  const difference = receiptTotal - sum;
  $("item-total").textContent = `Reviewed items: ${money(sum)} · Receipt total: ${money(receiptTotal)}${Math.abs(difference) > .005 ? ` · Difference: ${money(difference)}` : " · Totals match"}`;
}
function openEntry(next, defaults = {}, pdfImport) {
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
  $("settlement-copy").textContent = `You are recording a payment to ${memberDisplayName(partner())}.`;
  $("label").required = next !== "settlement";
  $("label").value = defaults.label || "";
  $("category").value = defaults.category || "Groceries";
  populatePayers(defaults.paid_by || session.user.id);
  $("personal").checked = !!defaults.personal;
  $("personal").disabled = !!pdfImport;
  $("amount").value = defaults.amount || "";
  $("date").value = defaults.date || today();
  $("dialog-error").textContent = "";
  $("save").disabled = false;
  $("save").textContent = "Save";
  if (pdfImport) renderItemRows();
  dialog.showModal();
  requestAnimationFrame(() => (next === "settlement" ? $("amount") : $("label")).focus());
}
function closeEntry() {
  if (pendingPdfImport && !confirm("Discard this local PDF draft? The PDF and extracted text will not be stored.")) return;
  pendingPdfImport = undefined;
  reviewedItems = [];
  formDirty = false;
  dialog.close();
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
    ({ error } = await supabase.from("settlements").insert({ household_id: current.id, payer: session.user.id, receiver: receiver.user_id, amount, settled_on: $("date").value }));
  } else {
    const label = $("label").value.trim();
    if (!label) { errorBox.textContent = "Add a merchant or description."; button.disabled = false; button.textContent = "Save"; return; }
    const paidBy = $("paid-by").value;
    if (!members.some(member => member.user_id === paidBy)) { errorBox.textContent = "Choose a current household member who paid this expense."; button.disabled = false; button.textContent = "Save"; return; }
    const personal = $("personal").checked;
    if (!personal && !hasPartner()) { errorBox.textContent = "Your partner must join before saving a shared expense."; button.disabled = false; button.textContent = "Save"; return; }
    if (pendingPdfImport) {
      const items = reviewedItems.map((item, display_order) => ({ name: item.name.trim(), quantity: item.quantity === "" ? null : Number(item.quantity), unit: item.unit.trim() || null, unit_price: item.unit_price === "" || item.unit_price == null ? null : Number(item.unit_price), line_total: item.line_total === "" || item.line_total == null ? null : Number(item.line_total), is_personal: !!item.is_personal, is_tracked_for_restock: !item.is_personal && !!item.is_tracked_for_restock, estimated_use_by: item.estimated_use_by || null, display_order }));
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
      const duplicateMessage = duplicateImportMessage(null, { label: $("label").value.trim(), purchased_on: $("date").value });
      lastPdfFeedback = { exactHash: pendingPdfImport.exactHash, contentHash: pendingPdfImport.contentHash, message: duplicateMessage };
      errorBox.textContent = duplicateMessage;
      errorBox.tabIndex = -1;
      errorBox.focus();
      note("");
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
  reviewedItems = [];
  formDirty = false;
  dialog.close();
  note(`${mode === "settlement" ? "Settlement" : "Expense"} saved and shared.`);
  await loadLedger();
};

async function archiveEntry(type, id) {
  if (!confirm("Archive this entry? It will stop affecting balances and restock suggestions.")) return;
  const table = type === "purchase" ? "purchases" : "settlements";
  const { error } = await supabase.from(table).update({ archived_at: new Date().toISOString(), archived_by: session.user.id }).eq("id", id);
  note(error ? error.message : "Entry archived.");
  if (!error) await loadLedger();
}
async function restoreEntry(type, id) {
  const table = type === "purchase" ? "purchases" : "settlements";
  const { error } = await supabase.from(table).update({ archived_at: null, archived_by: null }).eq("id", id);
  note(error ? error.message : "Entry restored; balances and suggestions were recalculated.");
  if (!error) await loadLedger();
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
    const rows = new Map();
    for (const item of content.items) {
      const y = Math.round(item.transform?.[5] || 0);
      rows.set(y, `${rows.get(y) || ""} ${item.str}`.trim());
    }
    pages.push([...rows.entries()].sort((a, b) => b[0] - a[0]).map(([y, text]) => ({ y, text })));
  }
  await pdf.destroy();
  const lines = pages.flatMap(page => page.map(line => line.text));
  const extractedText = lines.join("\n");
  const normalized = extractedText.toLowerCase().replace(/[^a-z0-9.,₹\n ]/g, "").replace(/[ \t]+/g, " ").trim();
  return { exactHash, contentHash: await sha256(normalized), ...parseReceipt(pages, today()) };
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
      showImportFeedback(lastPdfFeedback.message, "duplicate");
      return;
    }
    const { data, error } = await supabase.from("invoice_imports").select("imported_at").eq("household_id", current.id).or(`exact_pdf_hash.eq.${imported.exactHash},content_hash.eq.${imported.contentHash}`).order("imported_at", { ascending: false }).limit(1);
    if (error) { showImportFeedback(`Could not check whether this receipt was already imported. ${error.message}`, "error"); return; }
    if (data.length) {
      const message = duplicateImportMessage(data[0]);
      lastPdfFeedback = { exactHash: imported.exactHash, contentHash: imported.contentHash, message };
      showImportFeedback(message, "duplicate");
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
supabase.auth.onAuthStateChange((_event, nextSession) => {
  session = nextSession;
  if (!session) { current = undefined; members = []; ledger = { purchases: [], settlements: [], archivedPurchases: [], archivedSettlements: [] }; channel?.unsubscribe(); renderSignedOut(); }
  else loadHousehold();
});
const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
if (sessionError) renderLoadError("We couldn’t check your session.", sessionError.message, () => location.reload());
else { session = sessionData.session; if (session) loadHousehold(); else renderSignedOut(); }
