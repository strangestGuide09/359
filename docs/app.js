import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";
const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const money = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
const fmt = d => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d}T12:00:00`));
const categories = ["Groceries", "Food", "Wi-Fi", "Water", "Household", "Other"];
let session, householdId, state = { purchases: [], settlements: [] }, channel;
let mode = "expense", pendingPdfImport;
const dialog = $("entry");
$("date").value = today();

function note(text) { $("status").textContent = text; }
function escape(text) { return text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
function labelFor(userId) { return userId === session?.user?.id ? "You" : "Other member"; }
function balance() {
  let total = 0;
  for (const item of state.purchases) if (!item.is_personal) total += item.paid_by === session.user.id ? Number(item.amount) / 2 : -Number(item.amount) / 2;
  for (const item of state.settlements) total += item.payer === session.user.id ? Number(item.amount) : -Number(item.amount);
  return total;
}
function render() {
  const total = balance();
  $("balance").textContent = Math.abs(total) < .005 ? "All settled up" : total > 0 ? `Other member owes you ${money(total)}` : `You owe other member ${money(-total)}`;
  $("count").textContent = `${state.purchases.length} saved`;
  const groups = {};
  state.purchases.filter(item => !item.is_personal && item.is_tracked_for_restock && ["Groceries", "Household"].includes(item.category)).forEach(item => (groups[item.label.trim().toLowerCase()] ??= []).push(item));
  const clues = Object.values(groups).map(items => {
    items.sort((a,b) => a.purchased_on.localeCompare(b.purchased_on));
    const dates = [...new Set(items.map(item => item.purchased_on))]; if (dates.length < 2) return null;
    const last = dates.at(-1), previous = dates.at(-2), latest = items.at(-1);
    const days = Math.max(1, Math.round((Date.parse(`${last}T12:00:00`) - Date.parse(`${previous}T12:00:00`)) / 86400000));
    const due = latest.estimated_use_by || new Date(Date.parse(`${last}T12:00:00`) + days * 86400000).toISOString().slice(0,10);
    return { label: latest.label, due, days, estimated: !!latest.estimated_use_by, count: dates.length };
  }).filter(Boolean).sort((a,b) => a.due.localeCompare(b.due));
  $("suggestions").className = clues.length ? "" : "empty";
  $("suggestions").innerHTML = clues.length ? clues.map(item => `<div class="suggestion"><div><b>${escape(item.label)}</b><span>${item.estimated ? "Estimated use-by" : `Latest interval: ${item.days} days`} · seen ${item.count} times</span></div><time class="${item.due <= today() ? "due" : ""}">${item.due <= today() ? "Review now" : `Around ${fmt(item.due)}`}</time></div>`).join("") : "Mark a grocery or household item for restock twice on different dates.";
  const purchases = [...state.purchases].sort((a,b) => b.purchased_on.localeCompare(a.purchased_on));
  $("expenses").className = purchases.length ? "" : "empty";
  $("expenses").innerHTML = purchases.length ? purchases.map(item => `<div class="expense"><div><b>${escape(item.label)}</b><span>${item.category} · paid by ${labelFor(item.paid_by)} · ${fmt(item.purchased_on)}${item.is_personal ? " · personal" : ""}</span></div><b>${money(item.amount)}</b></div>`).join("") : "No shared expenses yet.";
  const settlements = [...state.settlements].sort((a,b) => b.settled_on.localeCompare(a.settled_on));
  $("settlements").className = settlements.length ? "" : "empty";
  $("settlements").innerHTML = settlements.length ? settlements.map(item => `<div class="expense"><div><b>${labelFor(item.payer)} paid ${labelFor(item.receiver)}</b><span>${fmt(item.settled_on)}</span></div><b>${money(item.amount)}</b></div>`).join("") : "No settlements recorded.";
}
function setPanel(html) { $("sync-panel").innerHTML = html; }
const EMAIL_RETRY_KEY = "grocery-ledger-email-retry-at";
function retryTimeLabel(timestamp) { return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function panelSignedOut() {
  $("sync-state").textContent = "Sign in required";
  const retryAt = Number(localStorage.getItem(EMAIL_RETRY_KEY) || 0);
  const waiting = retryAt > Date.now();
  const retryMessage = `Try again at ${retryTimeLabel(retryAt)}.`;
  setPanel(`<div class="auth-intro"><p>SHARED ACCESS</p><h2>Sign in to your shared ledger</h2><small>A secure sign-in link goes to your email. Open it in this browser. To use another browser, copy the link there before opening it.</small></div><form id="login-form" class="auth-form"><label>Email<input id="login-email" type="email" required autocomplete="email" placeholder="you@example.com"></label><button id="send-link"${waiting ? " disabled" : ""}>${waiting ? retryMessage : "Send sign-in link"}</button></form><p id="auth-status" class="auth-status${waiting ? " error" : ""}" role="status" aria-live="polite">${waiting ? retryMessage : "Enter your email to receive a secure, one-time sign-in link."}</p>`);
  if (waiting) setTimeout(panelSignedOut, retryAt - Date.now() + 250);
  $("login-form").onsubmit = async event => {
    event.preventDefault();
    if (Number(localStorage.getItem(EMAIL_RETRY_KEY) || 0) > Date.now()) return;
    const button = $("send-link"), email = $("login-email").value.trim();
    button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = "Sending…"; $("auth-status").className = "auth-status working"; $("auth-status").textContent = "Sending a secure sign-in link…";
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } });
    button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = "Send another link";
    const rateLimited = error?.message?.toLowerCase().includes("email rate limit");
    if (rateLimited) {
      const nextTry = Date.now() + 60 * 60 * 1000;
      localStorage.setItem(EMAIL_RETRY_KEY, String(nextTry));
      button.disabled = true;
      button.textContent = `Try again at ${retryTimeLabel(nextTry)}`;
      $("auth-status").className = "auth-status error";
      $("auth-status").textContent = `Try again at ${retryTimeLabel(nextTry)}.`;
      setTimeout(panelSignedOut, nextTry - Date.now() + 250);
      return;
    }
    if (!error) localStorage.removeItem(EMAIL_RETRY_KEY);
    $("auth-status").className = `auth-status ${error ? "error" : "success"}`;
    $("auth-status").textContent = error ? `Could not send link: ${error.message}` : `Link sent to ${email}. Check Inbox and Spam, then open the newest link in this browser.`;
  };
}
function panelNoHousehold() {
  $("sync-state").textContent = "Signed in";
  setPanel(`<div><p>SHARED ACCESS</p><h2>Create or join a household</h2><small>Use a household invite code to connect the two separate accounts.</small></div><form id="household-form"><label>New household name<input id="household-name" placeholder="Ekta & Ritesh" maxlength="80"></label><button id="create-household">Create</button><label>Invite code<input id="invite-code" placeholder="Paste a household invite code"></label><button id="join-household" class="secondary" type="button">Join</button><button id="sign-out" class="plain" type="button">Sign out</button></form>`);
  $("create-household").onclick = async () => { const name = $("household-name").value.trim(); if (!name) return note("Enter a household name."); const { data, error } = await supabase.rpc("create_household", { household_name: name }); if (error) return note(error.message); note(`Household created. Share this invite code once: ${data[0].invite_code}`); await loadHousehold(); };
  $("join-household").onclick = async () => { const code = $("invite-code").value.trim(); const { error } = await supabase.rpc("join_household", { code }); if (error) return note(error.message); note("Joined shared household."); await loadHousehold(); };
  $("sign-out").onclick = () => supabase.auth.signOut();
}
function panelReady(inviteCode, isOwner) {
  $("sync-state").textContent = "Shared sync on";
  const inviteActions = isOwner && inviteCode ? `<div class="invite-actions"><span>Invite Mac 1 without storing an email address here.</span><button id="email-invite" class="secondary" type="button">Email invite</button><button id="copy-invite" class="plain" type="button">Copy code</button></div>` : "";
  setPanel(`<div><p>SHARED ACCESS</p><h2>Live household ledger</h2><small>Updates sync to signed-in household members. Receipt PDFs and payment details are not synced.</small></div>${inviteActions}<button id="sign-out" class="secondary">Sign out</button>`);
  if (isOwner && inviteCode) {
    const inviteText = `Join my Grocery Ledger household. Open ${location.origin}${location.pathname}, sign in, then enter this invite code:\n\n${inviteCode}`;
    $("email-invite").onclick = () => { location.href = `mailto:?subject=${encodeURIComponent("Join my Grocery Ledger household")}&body=${encodeURIComponent(inviteText)}`; };
    $("copy-invite").onclick = async () => {
      try { await navigator.clipboard.writeText(inviteCode); note("Invite code copied. You can paste it into an email or Mac 1."); }
      catch { note(`Copy is unavailable in this browser. Invite code: ${inviteCode}`); }
    };
  }
  $("sign-out").onclick = () => supabase.auth.signOut();
}
async function loadLedger() {
  const [purchases, settlements] = await Promise.all([
    supabase.from("purchases").select("*").eq("household_id", householdId),
    supabase.from("settlements").select("*").eq("household_id", householdId)
  ]);
  if (purchases.error || settlements.error) return note(purchases.error?.message || settlements.error?.message || "Could not load ledger.");
  state = { purchases: purchases.data, settlements: settlements.data }; render();
  channel?.unsubscribe();
  channel = supabase.channel(`household-${householdId}`).on("postgres_changes", { event: "*", schema: "public", table: "purchases", filter: `household_id=eq.${householdId}` }, loadLedger).on("postgres_changes", { event: "*", schema: "public", table: "settlements", filter: `household_id=eq.${householdId}` }, loadLedger).subscribe();
}
async function loadHousehold() {
  const { data, error } = await supabase.from("household_members").select("household_id,role").eq("user_id", session.user.id).limit(1);
  if (error) return note(error.message);
  if (!data.length) { householdId = undefined; state = { purchases: [], settlements: [] }; render(); return panelNoHousehold(); }
  householdId = data[0].household_id;
  const { data: household, error: householdError } = await supabase.from("households").select("invite_code").eq("id", householdId).single();
  if (householdError) return note(householdError.message);
  panelReady(household.invite_code, data[0].role === "owner"); await loadLedger();
}
function open(next, defaults = {}, pdfImport) { mode = next; pendingPdfImport = pdfImport; $("dialog-title").textContent = next === "expense" ? (pdfImport ? "Review PDF import" : "Add expense") : "Record payment"; $("expense-fields").classList.toggle("hide", next !== "expense"); $("settlement-fields").classList.toggle("hide", next !== "settlement"); $("label").required = next === "expense"; $("amount").value = defaults.amount || ""; $("label").value = defaults.label || ""; $("date").value = defaults.date || today(); $("category").value = defaults.category || "Groceries"; $("tracked").checked = !!defaults.tracked; $("personal").checked = false; $("useby-label").classList.toggle("hide", !defaults.tracked); dialog.showModal(); }
$("add").onclick = () => householdId ? open("expense") : note("Sign in and join a household first.");
$("settle").onclick = () => householdId ? open("settlement") : note("Sign in and join a household first.");
$("close").onclick = () => dialog.close("cancel"); $("cancel").onclick = () => dialog.close("cancel");
$("tracked").onchange = event => $("useby-label").classList.toggle("hide", !event.target.checked);
$("demo").onclick = () => note("Demo data is disabled for the shared ledger so it cannot overwrite household records.");
dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "default" || !householdId) { pendingPdfImport = undefined; return; }
  const amount = Number($("amount").value); if (!Number.isFinite(amount) || amount <= 0) return;
  const payload = mode === "expense" ? { household_id: householdId, label: $("label").value.trim(), category: $("category").value, amount, paid_by: session.user.id, purchased_on: $("date").value, is_personal: $("personal").checked, is_tracked_for_restock: $("tracked").checked && !$("personal").checked, estimated_use_by: $("tracked").checked ? $("useby").value || null : null } : { household_id: householdId, payer: session.user.id, receiver: "00000000-0000-0000-0000-000000000000", amount, settled_on: $("date").value };
  if (mode === "settlement") { const other = (await supabase.from("household_members").select("user_id").eq("household_id", householdId).neq("user_id", session.user.id).limit(1)).data?.[0]; if (!other) return note("Wait for the other member to join before recording a settlement."); payload.receiver = other.user_id; }
  if (mode === "expense" && !payload.label) return;
  if (mode === "expense" && pendingPdfImport) {
    const { error } = await supabase.rpc("import_purchase", { p_household_id: householdId, p_exact_pdf_hash: pendingPdfImport.exactHash, p_content_hash: pendingPdfImport.contentHash, p_label: payload.label, p_category: payload.category, p_amount: payload.amount, p_purchased_on: payload.purchased_on, p_is_personal: payload.is_personal, p_is_tracked_for_restock: payload.is_tracked_for_restock, p_estimated_use_by: payload.estimated_use_by });
    pendingPdfImport = undefined;
    return note(error ? error.message : "PDF reviewed, saved, and shared. The PDF itself was discarded.");
  }
  const { error } = await supabase.from(mode === "expense" ? "purchases" : "settlements").insert(payload); note(error ? error.message : `${mode === "expense" ? "Expense" : "Settlement"} saved and shared.`);
});

async function sha256(value) { const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value; return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function pdfDefaults(text) {
  const amounts = [...text.matchAll(/(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.[0-9]{2})/gi)].map(match => Number(match[1].replaceAll(",", ""))).filter(Number.isFinite);
  const date = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  const parsedDate = date ? new Date(`${date[3].length === 2 ? `20${date[3]}` : date[3]}-${date[2].padStart(2, "0")}-${date[1].padStart(2, "0")}T12:00:00`) : null;
  return { label: "Receipt import — review name", amount: amounts.length ? Math.max(...amounts).toFixed(2) : "", date: parsedDate && !Number.isNaN(parsedDate) ? parsedDate.toISOString().slice(0, 10) : today(), category: "Groceries" };
}
async function readPdfLocally(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const exactHash = await sha256(bytes);
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pageText = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) { const page = await pdf.getPage(pageNumber); const content = await page.getTextContent(); pageText.push(content.items.map(item => item.str).join(" ")); }
  await pdf.destroy();
  const normalized = pageText.join(" ").toLowerCase().replace(/[^a-z0-9.,₹ ]/g, "").replace(/\s+/g, " ").trim();
  return { exactHash, contentHash: await sha256(normalized), defaults: pdfDefaults(pageText.join(" ")) };
}
$("import-pdf").onclick = () => householdId ? $("pdf-file").click() : note("Sign in and join a household first.");
$("pdf-file").onchange = async event => {
  const file = event.target.files?.[0]; event.target.value = "";
  if (!file || !householdId) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return note("Choose a PDF receipt or invoice.");
  note("Reading the PDF locally. It will not be uploaded or stored.");
  try {
    const imported = await readPdfLocally(file);
    const { data, error } = await supabase.from("invoice_imports").select("imported_at").eq("household_id", householdId).or(`exact_pdf_hash.eq.${imported.exactHash},content_hash.eq.${imported.contentHash}`).limit(1);
    if (error) return note(error.message);
    if (data.length) return note(`This bill was already imported on ${fmt(data[0].imported_at)}. No expense was added.`);
    open("expense", imported.defaults, imported); note("PDF read locally. Review every field before saving; the file is discarded.");
  } catch (error) { note(`Could not read this PDF locally: ${error.message}`); }
};
supabase.auth.onAuthStateChange((_event, nextSession) => { session = nextSession; if (!session) { householdId = undefined; state = { purchases: [], settlements: [] }; render(); return panelSignedOut(); } loadHousehold(); });
const { data: auth } = await supabase.auth.getSession(); session = auth.session; if (session) await loadHousehold(); else panelSignedOut(); render();
