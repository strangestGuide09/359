import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("shared web flow has explicit safe loading and recovery states", async () => {
  const [page, app, style] = await Promise.all([read("docs/index.html"), read("docs/app.js"), read("docs/style.css")]);
  assert.match(page, /id="screen"/);
  assert.doesNotMatch(page, /id="screen" aria-live/);
  assert.match(app, /function renderLoading/);
  assert.match(app, /function renderLoadError/);
  assert.match(app, /Your balance is hidden until current ledger data loads/);
  assert.doesNotMatch(app, /return renderDashboard\(\);/);
  assert.match(app, /function renderSignedOut/);
  assert.match(app, /function renderHouseholdSetup/);
  assert.match(app, /function renderPartnerInvite/);
  assert.match(app, /function renderDashboard/);
  assert.match(app, /persistSession: true/);
  assert.match(app, /autoRefreshToken: true/);
  assert.match(app, /open it in this same laptop browser/);
  assert.match(app, /emailRedirectTo: `\$\{location\.origin\}\$\{location\.pathname\}\$\{location\.search\}`/);
  assert.match(app, /shouldCreateUser: creating/);
  assert.match(app, /options\.data = \{ display_name: displayName \}/);
  assert.match(app, /id="show-signin"/);
  assert.match(app, /id="show-signup"/);
  assert.match(app, /id="signup-name"/);
  assert.match(app, /addEventListener\("offline"/);
  assert.match(app, /addEventListener\("online"/);
  assert.match(style, /h1\[tabindex="-1"\]:focus \{ outline:none; \}/);
  assert.match(style, /button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible/);
  assert.match(style, /\.account-gate \.auth-form input,\.account-gate \.auth-form button \{ height:43px; \}/);
  assert.match(style, /\.account-gate \.auth-status \{ width:100%; \}/);
  assert.match(style, /button \{ min-height:43px;/);
  assert.match(style, /input,select \{ width:100%; min-height:43px;/);
  assert.match(style, /dialog form>div:first-child button \{ width:44px; height:44px;/);
  assert.match(style, /\.state-panel button \{ margin-top:20px; \}/);
});

test("production UI is owner and partner only and gates shared actions", async () => {
  const [page, app] = await Promise.all([read("docs/index.html"), read("docs/app.js")]);
  assert.match(app, /function hasPartner\(\)/);
  assert.match(app, /Shared expenses, balances, settlements, and restock history stay locked/);
  assert.match(app, /Your partner must join before saving a shared expense/);
  assert.match(app, /Your partner must join before recording a settlement/);
  assert.doesNotMatch(app, /request_admin_access/);
  assert.doesNotMatch(app, /resolve_admin_request/);
  assert.doesNotMatch(app, /Request admin access/);
  assert.doesNotMatch(app, /Choose a household/);
  assert.match(app, /function inviteCodeFromUrl/);
  assert.match(app, /Copy invite link/);
  assert.match(app, /\?invite=\$\{encodeURIComponent\(code\)\}/);
  assert.match(app, /clearInviteFromUrl\(\)/);
  assert.match(app, /select\("user_id,role,display_name"\)/);
  assert.match(app, /function memberDisplayName/);
  assert.match(app, /function needsDisplayName/);
  assert.match(app, /function renderDisplayNameGate/);
  assert.match(app, /set_my_display_name/);
  assert.match(app, /p_display_name: setupName\(\)/);
  assert.match(app, /id="display-name-form"/);
  assert.match(app, /p_paid_by: paidBy/);
  assert.match(app, /paid_by: paidBy/);
  assert.match(page, /<select id="paid-by" required/);
  assert.match(page, /Choose who actually paid/);
});

test("clean bootstrap enforces the approved two-person lifecycle", async () => {
  const sql = await read("supabase/migrations/20260715000000_clean_bootstrap.sql");
  assert.match(sql, /role in \('owner', 'partner'\)/);
  assert.match(sql, /A household can have at most two active members/);
  assert.match(sql, /An account can belong to only one active household/);
  assert.match(sql, /A partner must join before adding shared expenses/);
  assert.match(sql, /A partner must join before recording settlements/);
  assert.match(sql, /interval '30 days'/);
  assert.match(sql, /Transfer ownership before removing the owner/);
  assert.match(sql, /Settle every member''s balance before archiving this household/);
  assert.match(sql, /purge_after<=now\(\)/);
  assert.match(sql, /create function public\.create_household_invite/);
  assert.match(sql, /create function public\.create_household\(household_name text, p_display_name text\)/);
  assert.match(sql, /create function public\.join_household\(code uuid, p_display_name text\)/);
  assert.match(sql, /create function public\.set_my_display_name\(p_display_name text\)/);
  assert.match(sql, /Invalid or inactive household invite code/);
  assert.doesNotMatch(sql, /admin_requests|request_admin_access|resolve_admin_request/);
});

test("local PDF privacy and duplicate safeguards remain present", async () => {
  const [app, feedback, restock, sql] = await Promise.all([read("docs/app.js"), read("docs/import-feedback.js"), read("docs/restock.js"), read("supabase/migrations/20260715000000_clean_bootstrap.sql")]);
  assert.match(app, /Reading this PDF locally\. It will not be uploaded or stored/);
  assert.match(app, /exactHash/);
  assert.match(app, /contentHash/);
  assert.match(app, /import_reviewed_purchase/);
  assert.match(app, /p_items: items/);
  assert.match(app, /purchase_items\(\*\)/);
  assert.match(restock, /for \(const item of purchase\.purchase_items \|\| \[\]\)/);
  assert.match(app, /is_personal: !!item\.is_personal/);
  assert.match(app, /display_order/);
  assert.match(app, /Reviewed item totals must match the receipt total/);
  assert.match(app, /parserWarning/);
  assert.match(app, /parserNotice/);
  assert.match(app, /showImportFeedback\(message, "duplicate"\)/);
  assert.match(app, /sameFingerprint\(imported, pendingPdfImport\)/);
  assert.match(app, /sameFingerprint\(imported, lastPdfFeedback\)/);
  assert.match(app, /isDuplicateImportError\(error\)/);
  assert.match(app, /errorBox\.textContent = duplicateMessage;[\s\S]{0,180}note\(""\);/);
  assert.doesNotMatch(app, /errorBox\.textContent = duplicateMessage;[\s\S]{0,180}note\(duplicateMessage\);/);
  assert.match(app, /\$\("dialog-error"\)\.textContent = message;\n\s+note\(""\);/);
  assert.doesNotMatch(app, /\$\("dialog-error"\)\.textContent = message;\n\s+note\(message\);/);
  assert.match(app, /input\.value = "";\n    setPdfBusy\(false\);/);
  assert.match(app, /Review Expenses or archived entries instead/);
  assert.match(feedback, /feedbackTimers/);
  assert.match(feedback, /durationMs = 10000/);
  assert.match(feedback, /Dismiss notification/);
  assert.doesNotMatch(app, /note\(message\);\n\s*if \(!dialog\.open\)/);
  assert.doesNotMatch(app, /p_(?:pdf|raw|extracted|receipt_text)/i);
  assert.match(sql, /unique \(household_id, exact_pdf_hash\)/);
  assert.match(sql, /unique \(household_id, content_hash\)/);
});

test("production client uses the validated hosted project public credentials", async () => {
  const config = await read("docs/supabase-config.js");
  assert.match(config, /https:\/\/yhcucqzikcqrlhgjwywe\.supabase\.co/);
  assert.match(config, /sb_publishable_u86CrClAiFcaxFHINCr4Jw_fTFKq7Il/);
  assert.doesNotMatch(config, /service_role|sb_secret_/);
});

test("mixed reviewed receipts use shared item totals for balances and restock", async () => {
  const [app, restock] = await Promise.all([read("docs/app.js"), read("docs/restock.js")]);
  assert.match(app, /function sharedPurchaseAmount/);
  assert.match(app, /item\.is_personal \? 0/);
  assert.match(restock, /if \(item\.is_personal \|\| !item\.is_tracked_for_restock/);
  assert.match(app, /Tracking \$\{groups\.size\} item/);
});

test("itemized review is editable and retains failed drafts", async () => {
  const [page, app, style] = await Promise.all([read("docs/index.html"), read("docs/app.js"), read("docs/style.css")]);
  assert.match(page, /id="item-rows"/);
  assert.match(page, /id="add-item"/);
  assert.match(page, /Only these reviewed fields will sync/);
  assert.match(app, /class="plain remove-item"/);
  assert.match(app, /Your draft is still here/);
  assert.match(app, /if \(error\) \{/);
  assert.match(app, /Your draft is still here; check your connection and retry/);
  assert.match(app, /is_tracked_for_restock: personal \? false : values\.is_tracked_for_restock \?\? true/);
  assert.match(app, /if \(field === "is_personal"\) reviewedItems\[index\]\.is_tracked_for_restock = !input\.checked/);
  assert.match(app, /<summary>More details<\/summary>/);
  assert.match(style, /\.item-primary \{ display:grid;/);
  assert.match(style, /\.item-details>div \{ display:grid;/);
  assert.match(style, /\.item-total \{ position:sticky;/);
  assert.match(style, /\.pdf-review-dialog menu \{ position:sticky;/);
  assert.match(style, /\.item-row \{[^}]*background:#fffaf0;/);
});

test("authenticated dashboard prioritizes household work and one main landmark", async () => {
  const [page, app, style] = await Promise.all([read("docs/index.html"), read("docs/app.js"), read("docs/style.css")]);
  assert.equal((page.match(/<main>/g) || []).length, 1);
  assert.equal((app.match(/function renderDashboard\(\)/g) || []).length, 1);
  assert.equal((app.match(/bindDashboard\(balance\);/g) || []).length, 1);
  assert.match(app, /class="dashboard-head"/);
  assert.match(app, /class="dashboard-grid"/);
  assert.match(app, /<section class="dashboard-main">/);
  assert.doesNotMatch(app, /<main class="dashboard-main">/);
  assert.match(app, /class="primary-actions"/);
  assert.match(app, /class="privacy-disclosure"/);
  assert.match(app, /<details class="panel settings">/);
  assert.doesNotMatch(app, /Split the bill\.<br><i>See what’s next/);
  assert.match(style, /\.dashboard-grid \{ display:grid; grid-template-columns:minmax\(0,1\.65fr\)/);
  assert.doesNotMatch(style, /\.activity,\.settings \{ margin-top:/);
  assert.match(style, /\.expenses-panel,\.compact-card \{ margin:0; \}/);
});

test("repository declares docs as the production web client", async () => {
  const [readme, prototypeReadme] = await Promise.all([read("README.md"), read("web/README.md")]);
  assert.match(readme, /`docs\/` is the production web client/);
  assert.match(readme, /limited to exactly two active members/);
  assert.match(prototypeReadme, /retired browser-local prototype/);
  assert.match(prototypeReadme, /Do not deploy this directory/);
});
