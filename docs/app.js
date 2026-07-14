import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

// Keep the authenticated session in this browser so a normal reload, new tab,
// or browser restart returns the person to their selected ledger. Only Sign out,
// an expired session, or cleared browser site data requires another email link.
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.localStorage }
});
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";
const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const money = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
const fmt = d => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d}T12:00:00`));
const esc = text => String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const retryKey = "grocery-ledger-email-retry-at";
let session, households = [], current, members = [], ledger = { purchases: [], settlements: [], archivedPurchases: [], archivedSettlements: [] }, requests = [], channel, mode = "expense", pendingPdfImport;
const dialog = $("entry"); $("date").value = today();

function note(text) { $("status").textContent = text || ""; }
function active() { return current && !current.archived_at; }
function isOwner() { return current?.role === "owner"; }
function isManager() { return ["owner", "admin"].includes(current?.role); }
function memberName(id) { return id === session?.user?.id ? "You" : "Another member"; }
function selectedKey() { return "grocery-ledger-active-household"; }
function setScreen(html) { $("screen").innerHTML = html; }
function currentMemberCount() { return Math.max(members.length, 1); }
function balanceFor(userId) {
  const share = currentMemberCount(); let total = 0;
  for (const item of ledger.purchases) if (!item.is_personal) total += item.paid_by === userId ? Number(item.amount) * (1 - 1 / share) : -Number(item.amount) / share;
  for (const item of ledger.settlements) total += item.payer === userId ? Number(item.amount) : item.receiver === userId ? -Number(item.amount) : 0;
  return total;
}
function row(item, type) {
  const own = type === "purchase" ? item.paid_by === session.user.id : item.payer === session.user.id;
  const canManage = own || isManager();
  const heading = type === "purchase" ? esc(item.label) : `${memberName(item.payer)} paid ${memberName(item.receiver)}`;
  const sub = type === "purchase" ? `${item.category} · paid by ${memberName(item.paid_by)} · ${fmt(item.purchased_on)}${item.is_personal ? " · personal" : ""}` : fmt(item.settled_on);
  return `<div class="expense"><div><b>${heading}</b><span>${sub}</span></div><div class="entry-actions"><b>${money(item.amount)}</b>${canManage && active() ? `<button class="plain action" data-archive="${type}" data-id="${item.id}">Archive</button>` : ""}</div></div>`;
}
function suggestions() {
  const groups = {};
  ledger.purchases.filter(i => !i.is_personal && i.is_tracked_for_restock && ["Groceries", "Household"].includes(i.category)).forEach(i => (groups[i.label.trim().toLowerCase()] ??= []).push(i));
  return Object.values(groups).map(items => {
    items.sort((a,b) => a.purchased_on.localeCompare(b.purchased_on));
    const dates = [...new Set(items.map(i => i.purchased_on))]; if (dates.length < 2) return null;
    const [previous, last] = dates.slice(-2); const days = Math.max(1, Math.round((Date.parse(`${last}T12:00:00`) - Date.parse(`${previous}T12:00:00`)) / 86400000)); const latest = items.at(-1);
    const due = latest.estimated_use_by || new Date(Date.parse(`${last}T12:00:00`) + days * 86400000).toISOString().slice(0, 10);
    return `<div class="suggestion"><div><b>${esc(latest.label)}</b><span>${latest.estimated_use_by ? "Estimated use-by" : `Latest interval: ${days} days`} · seen ${dates.length} times</span></div><time class="${due <= today() ? "due" : ""}">${due <= today() ? "Review now" : `Around ${fmt(due)}`}</time></div>`;
  }).filter(Boolean).join("") || "Mark a grocery or household item for restock twice on different dates.";
}

function renderSignedOut() {
  $("sync-state").textContent = "Sign in required";
  const retryAt = Number(localStorage.getItem(retryKey) || 0), waiting = retryAt > Date.now(), time = new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  setScreen(`<section class="panel account-gate"><p>WELCOME</p><h1>Grocery Ledger</h1><article>Sign in or create your account to continue. We’ll send a secure, one-time link to this browser.</article><form id="login-form" class="auth-form"><label>Email<input id="login-email" type="email" required autocomplete="email" placeholder="you@example.com"></label><button${waiting ? " disabled" : ""}>${waiting ? `Try again at ${time}` : "Continue with email"}</button></form><p id="auth-status" class="auth-status${waiting ? " error" : ""}">${waiting ? `Try again at ${time}.` : "No password, receipt, payment detail, or address is stored."}</p></section>`);
  $("login-form").onsubmit = async event => {
    event.preventDefault(); if (waiting) return;
    const button = $("login-form").querySelector("button"), email = $("login-email").value.trim(); button.disabled = true; button.textContent = "Sending…";
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
    if (error?.message?.toLowerCase().includes("email rate limit")) { const next = Date.now() + 3600000; localStorage.setItem(retryKey, next); return renderSignedOut(); }
    $("auth-status").className = `auth-status ${error ? "error" : "success"}`;
    $("auth-status").textContent = error ? "Could not send the link. Check the address and try again later." : `Link sent to ${email}. Check Inbox and Spam, then open the newest link here.`;
    button.disabled = false; button.textContent = "Send another link";
  };
}
function householdCard(item) { return `<button class="household-card ${item.id === current?.id ? "selected" : ""}" data-switch="${item.id}"><b>${esc(item.name)}</b><span>${item.archived_at ? `Archived · recovery until ${fmt(item.purge_after)}` : `${item.role[0].toUpperCase()}${item.role.slice(1)}`}</span></button>`; }
function renderHouseholdPicker() {
  $("sync-state").textContent = "Signed in";
  setScreen(`<section class="panel account-gate household-gate"><p>ACCOUNT SETUP</p><h1>${households.length ? "Choose a household" : "Create or join a household"}</h1><article>${households.length ? "Choose the ledger you want to open." : "Create your first ledger or join one with an invite code. You can send invites after a household is open."} Names do not need to be unique.</article>${households.length ? `<div class="household-list">${households.map(householdCard).join("")}</div>` : ""}<div class="two action-grid"><form id="create-form"><h2>Create household</h2><label>Household name<input id="household-name" maxlength="80" required placeholder="e.g. Ekta & Ritesh"></label><button>Create and open</button></form><form id="join-form"><h2>Join household</h2><label>Invite code<input id="invite-code" required placeholder="Paste a household invite code"></label><button class="secondary">Join and open</button></form></div><button id="sign-out" class="plain">Sign out</button></section>`);
  document.querySelectorAll("[data-switch]").forEach(button => button.onclick = () => chooseHousehold(button.dataset.switch));
  $("create-form").onsubmit = async event => { event.preventDefault(); const { data, error } = await supabase.rpc("create_household", { household_name: $("household-name").value.trim() }); if (error) return note(error.message); localStorage.setItem(selectedKey(), data[0].id); note("Household created. Invite a member from Settings."); await loadHouseholds(); };
  $("join-form").onsubmit = async event => { event.preventDefault(); const { data, error } = await supabase.rpc("join_household", { code: $("invite-code").value.trim() }); if (error) return note(error.message); localStorage.setItem(selectedKey(), data); note("Joined household."); await loadHouseholds(); };
  $("sign-out").onclick = () => supabase.auth.signOut();
}
function renderDashboard() {
  const yourBalance = balanceFor(session.user.id), archived = !!current.archived_at;
  $("sync-state").textContent = archived ? "Archived · read only" : "Shared sync on";
  const purchases = ledger.purchases.sort((a,b) => b.purchased_on.localeCompare(a.purchased_on)).map(i => row(i, "purchase")).join("") || "No shared expenses yet.";
  const settlements = ledger.settlements.sort((a,b) => b.settled_on.localeCompare(a.settled_on)).map(i => row(i, "settlement")).join("") || "No settlements recorded.";
  const roleRequest = current.role === "member" ? `<button id="request-admin" class="plain">Request admin access</button>` : "";
  const invites = isManager() && !archived ? `<button id="email-invite" class="secondary">Email invite</button><button id="copy-invite" class="plain">Copy invite code</button>` : "";
  const permanentlyDeletable = archived && new Date(current.purge_after) <= new Date();
  const ownerControls = isOwner() ? `<div class="settings-actions">${archived ? `<button id="restore-household" class="secondary">Restore household</button>${permanentlyDeletable ? `<button id="delete-household" class="danger">Permanently delete</button>` : `<small>Permanent deletion becomes available after ${fmt(current.purge_after)}.</small>`}` : `<button id="archive-household" class="danger">Archive household</button><small>Every member’s balance must be ₹0.00 first.</small>`}</div>` : "";
  const archivedEntries = [...ledger.archivedPurchases.map(i => ({ ...i, type: "purchase" })), ...ledger.archivedSettlements.map(i => ({ ...i, type: "settlement" }))];
  setScreen(`<section class="household-bar"><button id="household-picker" class="secondary">${esc(current.name)} ▾</button><span>${current.role[0].toUpperCase()}${current.role.slice(1)}</span></section><section class="hero"><div><p>SHARED HOME LEDGER</p><h1>Split the bill.<br><i>See what’s next.</i></h1><article>${archived ? `This household is archived and read-only until ${fmt(current.purge_after)}.` : "A private ledger for shared groceries, bills, and gentle restock cues."}</article></div><aside><small>Today’s balance</small><strong>${Math.abs(yourBalance) < .005 ? "All settled up" : yourBalance > 0 ? `Others owe you ${money(yourBalance)}` : `You owe ${money(-yourBalance)}`}</strong><small>${members.length} member${members.length === 1 ? "" : "s"} · equal split</small></aside></section>${archived ? "" : `<nav><button id="add">+ Add expense</button><button id="import-pdf" class="secondary">⇧ Import PDF</button><button id="settle" class="secondary">↔ Record settlement</button></nav>`}<section class="grid"><article class="panel"><p>RESTOCK</p><h2>Possible buys</h2><div>${suggestions()}</div></article><aside class="panel privacy"><p>PRIVACY PROMISE</p><h2>Only the reviewed ledger.</h2><ul><li>PDFs are processed locally, not uploaded.</li><li>No address, payment mode, card or UPI details.</li><li>Only reviewed ledger entries sync.</li></ul></aside></section><section class="panel activity"><div class="heading"><div><p>ACTIVITY</p><h2>Expenses</h2></div><span>${ledger.purchases.length} saved</span></div><div>${purchases}</div></section><section class="panel activity"><div class="heading"><div><p>SETTLEMENTS</p><h2>Payment history</h2></div></div><div>${settlements}</div></section><section class="panel settings"><p>HOUSEHOLD SETTINGS</p><h2>Members & access</h2><div class="member-list">${members.map(m => `<div class="expense"><div><b>${memberName(m.user_id)}</b><span>${m.role}</span></div>${isManager() && m.role !== "owner" && active() ? `<button class="plain action" data-remove-member="${m.user_id}">Remove</button>` : ""}</div>`).join("")}</div>${requests.filter(r => r.status === "pending").length && isOwner() ? `<h3>Admin requests</h3>${requests.filter(r => r.status === "pending").map(r => `<div class="expense"><b>Member requests admin access</b><span><button data-resolve="${r.id}" data-approve="true">Approve</button><button data-resolve="${r.id}" data-approve="false" class="secondary">Reject</button></span></div>`).join("")}` : ""}<div class="settings-actions">${invites}${roleRequest}${ownerControls}<button id="sign-out" class="plain">Sign out</button></div>${archivedEntries.length ? `<details class="archive-list"><summary>Archived entries (${archivedEntries.length})</summary>${archivedEntries.map(i => `<div class="expense"><div><b>${i.type === "purchase" ? esc(i.label) : "Archived settlement"}</b><span>${money(i.amount)}</span></div>${active() && (isManager() || (i.type === "purchase" ? i.paid_by : i.payer) === session.user.id) ? `<button class="secondary" data-restore-entry="${i.type}" data-id="${i.id}">Restore</button>` : ""}</div>`).join("")}</details>` : ""}</section>`);
  bindDashboard();
}
function bindDashboard() {
  $("household-picker").onclick = () => { current = undefined; renderHouseholdPicker(); };
  $("add") && ($("add").onclick = () => open("expense"));
  $("settle") && ($("settle").onclick = () => open("settlement"));
  $("import-pdf") && ($("import-pdf").onclick = () => $("pdf-file").click());
  $("sign-out").onclick = () => supabase.auth.signOut();
  $("request-admin") && ($("request-admin").onclick = async () => rpcNote("request_admin_access", { p_household_id: current.id }, "Admin request sent to the owner."));
  $("email-invite") && ($("email-invite").onclick = async () => { const code = await issueInvite(); if (code) location.href = `mailto:?subject=${encodeURIComponent("Join my Grocery Ledger household")}&body=${encodeURIComponent(`Open ${location.origin}${location.pathname}, sign in, and join with this invite code:\n\n${code}`)}`; });
  $("copy-invite") && ($("copy-invite").onclick = async () => { const code = await issueInvite(); if (!code) return; try { await navigator.clipboard.writeText(code); note("New invite code copied."); } catch { note("Copy is unavailable. Use Email invite instead."); } });
  $("archive-household") && ($("archive-household").onclick = async () => { if (confirm("Archive this household? It becomes read-only for 30 days and only the owner can restore it.")) await rpcNote("archive_household", { p_household_id: current.id }, "Household archived."); });
  $("restore-household") && ($("restore-household").onclick = async () => rpcNote("restore_household", { p_household_id: current.id }, "Household restored."));
  $("delete-household") && ($("delete-household").onclick = async () => { if (confirm("Permanently delete this household and all of its ledger data? This cannot be undone.")) await rpcNote("permanently_delete_household", { p_household_id: current.id }, "Household permanently deleted."); });
  document.querySelectorAll("[data-remove-member]").forEach(b => b.onclick = async () => { if (confirm("Remove this member? Their balance must be settled first.")) await rpcNote("remove_household_member", { p_household_id: current.id, p_member_id: b.dataset.removeMember }, "Member removed."); });
  document.querySelectorAll("[data-resolve]").forEach(b => b.onclick = async () => rpcNote("resolve_admin_request", { p_request_id: b.dataset.resolve, p_approve: b.dataset.approve === "true" }, b.dataset.approve === "true" ? "Admin access approved." : "Admin request rejected."));
  document.querySelectorAll("[data-archive]").forEach(b => b.onclick = () => archiveEntry(b.dataset.archive, b.dataset.id));
  document.querySelectorAll("[data-restore-entry]").forEach(b => b.onclick = () => restoreEntry(b.dataset.restoreEntry, b.dataset.id));
}
async function rpcNote(name, args, success) { const { error } = await supabase.rpc(name, args); note(error ? error.message : success); if (!error) await loadHouseholds(); }
async function issueInvite() { const { data, error } = await supabase.rpc("create_household_invite", { p_household_id: current.id }); if (error) { note(error.message); return null; } return data; }
async function chooseHousehold(id) { localStorage.setItem(selectedKey(), id); await loadHouseholds(); }
async function loadHouseholds() {
  if (!session) return renderSignedOut();
  const { data: memberships, error } = await supabase.from("household_members").select("household_id,role").eq("user_id", session.user.id);
  if (error) { note(`Could not load households: ${error.message}`); return renderHouseholdPicker(); }
  const result = await Promise.all(memberships.map(async m => { const { data } = await supabase.from("households").select("id,name,archived_at,purge_after").eq("id", m.household_id).maybeSingle(); return data && { ...data, role: m.role }; }));
  households = result.filter(Boolean).sort((a,b) => a.name.localeCompare(b.name));
  const saved = localStorage.getItem(selectedKey()); current = households.find(h => h.id === saved) || households.find(h => !h.archived_at) || households[0];
  if (!current) return renderHouseholdPicker(); await loadLedger();
}
async function loadLedger() {
  const [memberResult, purchaseResult, settlementResult, archivedPurchaseResult, archivedSettlementResult, requestResult] = await Promise.all([
    supabase.from("household_members").select("user_id,role").eq("household_id", current.id),
    supabase.from("purchases").select("*").eq("household_id", current.id).is("archived_at", null),
    supabase.from("settlements").select("*").eq("household_id", current.id).is("archived_at", null),
    supabase.from("purchases").select("*").eq("household_id", current.id).not("archived_at", "is", null),
    supabase.from("settlements").select("*").eq("household_id", current.id).not("archived_at", "is", null),
    supabase.from("admin_requests").select("*").eq("household_id", current.id)
  ]);
  const error = memberResult.error || purchaseResult.error || settlementResult.error || archivedPurchaseResult.error || archivedSettlementResult.error || requestResult.error;
  if (error) { note(`Could not load household: ${error.message}`); return renderDashboard(); }
  members = memberResult.data; ledger = { purchases: purchaseResult.data, settlements: settlementResult.data, archivedPurchases: archivedPurchaseResult.data, archivedSettlements: archivedSettlementResult.data }; requests = requestResult.data; renderDashboard();
  channel?.unsubscribe(); channel = supabase.channel(`household-${current.id}`).on("postgres_changes", { event: "*", schema: "public", table: "purchases", filter: `household_id=eq.${current.id}` }, loadLedger).on("postgres_changes", { event: "*", schema: "public", table: "settlements", filter: `household_id=eq.${current.id}` }, loadLedger).on("postgres_changes", { event: "*", schema: "public", table: "household_members", filter: `household_id=eq.${current.id}` }, loadHouseholds).subscribe();
}
function open(next, defaults = {}, pdfImport) { mode = next; pendingPdfImport = pdfImport; $("dialog-title").textContent = next === "expense" ? (pdfImport ? "Review PDF import" : "Add expense") : "Record settlement"; $("expense-fields").classList.toggle("hide", next !== "expense"); $("settlement-fields").classList.toggle("hide", next !== "settlement"); $("label").required = next === "expense"; $("amount").value = defaults.amount || ""; $("label").value = defaults.label || ""; $("date").value = defaults.date || today(); $("category").value = defaults.category || "Groceries"; $("tracked").checked = !!defaults.tracked; $("personal").checked = false; $("useby-label").classList.toggle("hide", !defaults.tracked); dialog.showModal(); }
$("close").onclick = () => dialog.close("cancel"); $("cancel").onclick = () => dialog.close("cancel"); $("tracked").onchange = e => $("useby-label").classList.toggle("hide", !e.target.checked);
dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "default" || !active()) { pendingPdfImport = undefined; return; }
  const amount = Number($("amount").value); if (!Number.isFinite(amount) || amount <= 0) return note("Enter an amount above zero.");
  let error;
  if (mode === "expense") {
    const payload = { household_id: current.id, label: $("label").value.trim(), category: $("category").value, amount, paid_by: session.user.id, purchased_on: $("date").value, is_personal: $("personal").checked, is_tracked_for_restock: $("tracked").checked && !$("personal").checked, estimated_use_by: $("tracked").checked ? $("useby").value || null : null };
    if (!payload.label) return note("Add a label before saving.");
    if (pendingPdfImport) ({ error } = await supabase.rpc("import_purchase", { p_household_id: current.id, p_exact_pdf_hash: pendingPdfImport.exactHash, p_content_hash: pendingPdfImport.contentHash, p_label: payload.label, p_category: payload.category, p_amount: payload.amount, p_purchased_on: payload.purchased_on, p_is_personal: payload.is_personal, p_is_tracked_for_restock: payload.is_tracked_for_restock, p_estimated_use_by: payload.estimated_use_by }));
    else ({ error } = await supabase.from("purchases").insert(payload));
  } else {
    const receiver = members.find(m => m.user_id !== session.user.id); if (!receiver) return note("A second member must join before recording a settlement.");
    ({ error } = await supabase.from("settlements").insert({ household_id: current.id, payer: session.user.id, receiver: receiver.user_id, amount, settled_on: $("date").value }));
  }
  pendingPdfImport = undefined; note(error ? error.message : `${mode === "expense" ? "Expense" : "Settlement"} saved and shared.`); if (!error) await loadLedger();
});
async function archiveEntry(type, id) { if (!confirm("Archive this entry? It will stop affecting balances and restock suggestions.")) return; const table = type === "purchase" ? "purchases" : "settlements"; const { error } = await supabase.from(table).update({ archived_at: new Date().toISOString(), archived_by: session.user.id }).eq("id", id); note(error ? error.message : "Entry archived."); if (!error) await loadLedger(); }
async function restoreEntry(type, id) { const table = type === "purchase" ? "purchases" : "settlements"; const { error } = await supabase.from(table).update({ archived_at: null, archived_by: null }).eq("id", id); note(error ? error.message : "Entry restored."); if (!error) await loadLedger(); }
async function sha256(value) { const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value; return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join(""); }
function pdfDefaults(text) { const amounts = [...text.matchAll(/(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.[0-9]{2})/gi)].map(m => Number(m[1].replaceAll(",", ""))).filter(Number.isFinite); return { label: "Receipt import — review name", amount: amounts.length ? Math.max(...amounts).toFixed(2) : "", date: today(), category: "Groceries" }; }
async function readPdfLocally(file) { const bytes = new Uint8Array(await file.arrayBuffer()), exactHash = await sha256(bytes), pdf = await pdfjsLib.getDocument({ data: bytes }).promise, texts = []; for (let n = 1; n <= pdf.numPages; n += 1) { const content = await (await pdf.getPage(n)).getTextContent(); texts.push(content.items.map(i => i.str).join(" ")); } await pdf.destroy(); const text = texts.join(" "), normalized = text.toLowerCase().replace(/[^a-z0-9.,₹ ]/g, "").replace(/\s+/g, " ").trim(); return { exactHash, contentHash: await sha256(normalized), defaults: pdfDefaults(text) }; }
$("pdf-file").onchange = async event => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !active()) return; if (!file.name.toLowerCase().endsWith(".pdf")) return note("Choose a PDF receipt or invoice."); try { note("Reading this PDF locally. It will not be uploaded or stored."); const imported = await readPdfLocally(file); const { data, error } = await supabase.from("invoice_imports").select("imported_at").eq("household_id", current.id).or(`exact_pdf_hash.eq.${imported.exactHash},content_hash.eq.${imported.contentHash}`).limit(1); if (error) return note(error.message); if (data.length) return note(`This bill was already imported on ${fmt(data[0].imported_at)}. No expense was added.`); open("expense", imported.defaults, imported); note("Review every field before saving; the PDF is discarded."); } catch (error) { note(`Could not read this PDF locally: ${error.message}`); } };
supabase.auth.onAuthStateChange((_event, next) => { session = next; if (!session) { current = undefined; households = []; ledger = { purchases: [], settlements: [] }; renderSignedOut(); } else loadHouseholds(); });
const { data } = await supabase.auth.getSession(); session = data.session; if (session) loadHouseholds(); else renderSignedOut();
