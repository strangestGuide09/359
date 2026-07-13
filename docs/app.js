import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const money = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
const fmt = d => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d}T12:00:00`));
const categories = ["Groceries", "Food", "Wi-Fi", "Water", "Household", "Other"];
let session, householdId, state = { purchases: [], settlements: [] }, channel;
let mode = "expense";
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
function panelSignedOut() {
  $("sync-state").textContent = "Sign in required";
  setPanel(`<div><p>SHARED ACCESS</p><h2>Sign in to your shared ledger</h2><small>We email a one-time sign-in link. It signs in the browser that opens it. To use a different browser, copy the email link and paste it into that browser’s address bar before opening it. No app password, receipt, payment detail, or address is stored.</small></div><form id="login-form"><label>Email<input id="login-email" type="email" required autocomplete="email"></label><button>Send sign-in link</button></form>`);
  $("login-form").onsubmit = async event => { event.preventDefault(); const email = $("login-email").value.trim(); const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } }); note(error ? error.message : "Check your email. Copy the sign-in link into the browser you want to use, then open it."); };
}
function panelNoHousehold() {
  $("sync-state").textContent = "Signed in";
  setPanel(`<div><p>SHARED ACCESS</p><h2>Create or join a household</h2><small>Use a household invite code to connect the two separate accounts.</small></div><form id="household-form"><label>New household name<input id="household-name" placeholder="Ekta & Ritesh" maxlength="80"></label><button id="create-household">Create</button><label>Invite code<input id="invite-code" placeholder="Paste a household invite code"></label><button id="join-household" class="secondary" type="button">Join</button><button id="sign-out" class="plain" type="button">Sign out</button></form>`);
  $("create-household").onclick = async () => { const name = $("household-name").value.trim(); if (!name) return note("Enter a household name."); const { data, error } = await supabase.rpc("create_household", { household_name: name }); if (error) return note(error.message); note(`Household created. Share this invite code once: ${data[0].invite_code}`); await loadHousehold(); };
  $("join-household").onclick = async () => { const code = $("invite-code").value.trim(); const { error } = await supabase.rpc("join_household", { code }); if (error) return note(error.message); note("Joined shared household."); await loadHousehold(); };
  $("sign-out").onclick = () => supabase.auth.signOut();
}
function panelReady() {
  $("sync-state").textContent = "Shared sync on";
  setPanel(`<div><p>SHARED ACCESS</p><h2>Live household ledger</h2><small>Updates sync to signed-in household members. Receipt PDFs and payment details are not synced.</small></div><button id="sign-out" class="secondary">Sign out</button>`);
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
  const { data, error } = await supabase.from("household_members").select("household_id").eq("user_id", session.user.id).limit(1);
  if (error) return note(error.message);
  if (!data.length) { householdId = undefined; state = { purchases: [], settlements: [] }; render(); return panelNoHousehold(); }
  householdId = data[0].household_id; panelReady(); await loadLedger();
}
function open(next) { mode = next; $("dialog-title").textContent = next === "expense" ? "Add expense" : "Record payment"; $("expense-fields").classList.toggle("hide", next !== "expense"); $("settlement-fields").classList.toggle("hide", next !== "settlement"); $("label").required = next === "expense"; $("amount").value = ""; $("label").value = ""; $("date").value = today(); dialog.showModal(); }
$("add").onclick = () => householdId ? open("expense") : note("Sign in and join a household first.");
$("settle").onclick = () => householdId ? open("settlement") : note("Sign in and join a household first.");
$("close").onclick = () => dialog.close("cancel"); $("cancel").onclick = () => dialog.close("cancel");
$("tracked").onchange = event => $("useby-label").classList.toggle("hide", !event.target.checked);
$("demo").onclick = () => note("Demo data is disabled for the shared ledger so it cannot overwrite household records.");
dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "default" || !householdId) return;
  const amount = Number($("amount").value); if (!Number.isFinite(amount) || amount <= 0) return;
  const payload = mode === "expense" ? { household_id: householdId, label: $("label").value.trim(), category: $("category").value, amount, paid_by: session.user.id, purchased_on: $("date").value, is_personal: $("personal").checked, is_tracked_for_restock: $("tracked").checked && !$("personal").checked, estimated_use_by: $("tracked").checked ? $("useby").value || null : null } : { household_id: householdId, payer: session.user.id, receiver: "00000000-0000-0000-0000-000000000000", amount, settled_on: $("date").value };
  if (mode === "settlement") { const other = (await supabase.from("household_members").select("user_id").eq("household_id", householdId).neq("user_id", session.user.id).limit(1)).data?.[0]; if (!other) return note("Wait for the other member to join before recording a settlement."); payload.receiver = other.user_id; }
  if (mode === "expense" && !payload.label) return;
  const { error } = await supabase.from(mode === "expense" ? "purchases" : "settlements").insert(payload); note(error ? error.message : `${mode === "expense" ? "Expense" : "Settlement"} saved and shared.`);
});
supabase.auth.onAuthStateChange((_event, nextSession) => { session = nextSession; if (!session) { householdId = undefined; state = { purchases: [], settlements: [] }; render(); return panelSignedOut(); } loadHousehold(); });
const { data: auth } = await supabase.auth.getSession(); session = auth.session; if (session) await loadHousehold(); else panelSignedOut(); render();
