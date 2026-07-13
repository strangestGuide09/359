from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.style import WD_STYLE_TYPE

OUT = 'Grocery_Slip_Tracker_Market_Research.docx'

def set_font(run, size=None, bold=None, color=None, italic=None):
    run.font.name = 'Calibri'
    run._element.rPr.rFonts.set(qn('w:ascii'), 'Calibri')
    run._element.rPr.rFonts.set(qn('w:hAnsi'), 'Calibri')
    if size: run.font.size = Pt(size)
    if bold is not None: run.bold = bold
    if color: run.font.color.rgb = RGBColor(*color)
    if italic is not None: run.italic = italic

def shade(cell, fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd'); shd.set(qn('w:fill'), fill); tcPr.append(shd)

def margins(cell, top=80, start=120, bottom=80, end=120):
    tc = cell._tc; tcPr = tc.get_or_add_tcPr(); node = tcPr.first_child_found_in('w:tcMar')
    if node is None:
        node = OxmlElement('w:tcMar'); tcPr.append(node)
    for side, value in [('top',top),('start',start),('bottom',bottom),('end',end)]:
        el = node.find(qn('w:' + side))
        if el is None: el = OxmlElement('w:' + side); node.append(el)
        el.set(qn('w:w'), str(value)); el.set(qn('w:type'), 'dxa')

def set_cell_text(cell, text, bold=False, color=None, size=9.5):
    cell.text = ''
    p = cell.paragraphs[0]; p.paragraph_format.space_after = Pt(0); p.paragraph_format.line_spacing = 1.05
    r = p.add_run(text); set_font(r, size=size, bold=bold, color=color)
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER; margins(cell)

def add_heading(doc, text, level=1):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14 if level == 1 else 9)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.keep_with_next = True
    r = p.add_run(text); set_font(r, 16 if level == 1 else 12.5, True, (46,116,181) if level == 1 else (31,77,120))
    return p

def add_body(doc, text, bold_lead=None):
    p = doc.add_paragraph(); p.paragraph_format.space_after = Pt(6); p.paragraph_format.line_spacing = 1.1
    if bold_lead:
        r = p.add_run(bold_lead); set_font(r, 10.5, True)
    r = p.add_run(text); set_font(r, 10.5)
    return p

def add_bullet(doc, text, size=10.5):
    p = doc.add_paragraph(style='List Bullet'); p.paragraph_format.space_after = Pt(3); p.paragraph_format.line_spacing = 1.1
    r = p.add_run(text); set_font(r, size)

def add_table(doc, headers, rows, widths):
    table = doc.add_table(rows=1, cols=len(headers)); table.alignment = WD_TABLE_ALIGNMENT.LEFT; table.autofit = False
    table.style = 'Table Grid'
    trPr = table.rows[0]._tr.get_or_add_trPr()
    tblHeader = OxmlElement('w:tblHeader'); tblHeader.set(qn('w:val'), 'true'); trPr.append(tblHeader)
    for i,h in enumerate(headers):
        c = table.rows[0].cells[i]; c.width = Inches(widths[i]); shade(c, 'F2F4F7'); set_cell_text(c,h,True,(31,77,120),9)
    for row in rows:
        cells = table.add_row().cells
        for i,v in enumerate(row):
            cells[i].width=Inches(widths[i]); set_cell_text(cells[i], v, False, None, 9)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return table

doc = Document()
sec = doc.sections[0]; sec.top_margin=Inches(0.8); sec.bottom_margin=Inches(0.75); sec.left_margin=Inches(0.8); sec.right_margin=Inches(0.8)
styles = doc.styles
styles['Normal'].font.name='Calibri'; styles['Normal']._element.rPr.rFonts.set(qn('w:hAnsi'),'Calibri'); styles['Normal'].font.size=Pt(10.5)

# Header/footer
hp=sec.header.paragraphs[0]; hp.alignment=WD_ALIGN_PARAGRAPH.RIGHT; r=hp.add_run('PROJECT HUB  |  MARKET RESEARCH'); set_font(r,8.5,True,(89,89,89))
fp=sec.footer.paragraphs[0]; fp.alignment=WD_ALIGN_PARAGRAPH.CENTER; r=fp.add_run('Grocery Slip & Shared Household Tracker  •  Research snapshot: 12 July 2026'); set_font(r,8,color=(89,89,89))

p=doc.add_paragraph(); p.paragraph_format.space_before=Pt(16); p.paragraph_format.space_after=Pt(4)
r=p.add_run('Grocery Slip & Shared Household Tracker'); set_font(r,23,True,(11,37,69))
p=doc.add_paragraph(); p.paragraph_format.space_after=Pt(14); r=p.add_run('Market research, confirmed v0 direction, and remaining decisions'); set_font(r,13,False,(85,85,85))

meta=doc.add_paragraph(); meta.paragraph_format.space_after=Pt(12)
for label,val in [('Status','v0 direction recorded and implementation updated'),('Scope','Personal tool for India; iPhone and Mac available'),('Date','12 July 2026')]:
    rr=meta.add_run(label + ': '); set_font(rr,9.5,True,(31,77,120)); rr=meta.add_run(val + '   '); set_font(rr,9.5)

add_heading(doc,'Executive take',1)
add_body(doc,'The concept solves a real shared-household problem, but it is not a blank market. Users can already get free bill splitting from Tricount, receipt/item splitting from Splitwise Pro, and stock/restock tracking from Grocy or Pantry Check. The defensible idea is the bridge: turn a grocery receipt into a shared, explainable household ledger and a replenishment plan without asking people to maintain inventory manually.')
add_body(doc,'Do not begin by building a broad “AI grocery app.” Start by testing one specific promise: “photograph a grocery receipt; each housemate confirms what is shared; the app settles fairly and creates a low-confidence-to-high-confidence restock list.” The greatest product risk is not OCR—it is getting reliable consumption data with little household effort.', 'My honest recommendation: ')

add_heading(doc,'Decisions recorded — 11 July 2026',1)
add_body(doc,'The project now has a concrete personal-tool direction. These are confirmed decisions from the project owner, not product assumptions.')
add_table(doc,['Area','Confirmed direction'],[
    ['First user','The project owner is the first customer and test subject.'],
    ['Market','India; the first version should handle Indian grocery invoices and INR.'],
    ['Project intent','Personal tool initially. It may later be open-sourced or monetized, but neither path drives v0 decisions.'],
    ['Core problem','Avoid using one app to split a grocery bill and another to check what is missing from the fridge/pantry.'],
    ['Replenishment promise','Show inventory and possible items to buy. Predictions may mature from history; they are suggestions, not definitive stock claims.'],
    ['First receipt input','Existing PDF invoices only. The supplied samples establish Instamart and Blinkit/Zomato Hyperpure as the first invoice families to support. Camera images, email invoices, and retailer integrations are explicitly later scope.'],
    ['Shared-item rule','Default split is equal between Ekta and Ritesh after import. The review screen must let either person later mark any line as personal/remove it from the shared split and recalculate the balance.'],
    ['Confirmation model','Lightweight confirmations are acceptable for the single initial user.'],
    ['Group money','Track balances for the Ekta/Ritesh group. Record manual Splitwise-style settlements (payer, receiver, amount, date, optional note) that reduce balances; no payment collection, UPI links, or payment reminders in v0.'],
    ['Reminders','Push notifications and an in-app “what may be needed” view.'],
    ['Devices and storage','iPhone-first v0. Store only the minimum local ledger data on the iPhone with no sync initially; parse invoices in memory and discard them. A Mac companion is not required for the initial release.'],
], [1.45,5.25])
add_body(doc,'A PDF invoice becomes an editable purchase record and is initially divided equally between Ekta and Ritesh. At any time, either person can mark a line as personal and remove it from the shared calculation. The app recalculates the balances, records settlements separately, optionally marks repeat items as inventory-tracked, and later accepts lightweight consumption/stock confirmations. It surfaces a ranked, explainable “possibly buy” list with a reason and confidence—not an automatic order.', 'V0 interpretation: ')

add_heading(doc,'PDF validation — supplied invoice set',1)
add_body(doc,'I inspected 10 supplied files: 9 unique invoices plus one exact duplicate (the two files for order 242060854872088). All invoices have selectable text and structured tables; v0 can use vendor-specific text/table extraction rather than OCR. The supplied set contains three unique Instamart invoices and six Blinkit/Zomato Hyperpure invoices, dated 29 June–10 July 2026.')
add_table(doc,['Finding','V0 implication'],[
    ['Reliable digital text','Start with deterministic parsing. Show every extracted field in an editable review screen, then discard the source PDF; do not rely on an opaque AI extraction step.'],
    ['Multi-page invoices','Support 2–5 page documents and aggregate line items across pages before calculating the balance.'],
    ['Instamart layout','Items appear in a fixed table with quantity, discount, net taxable value, CGST/SGST, total, invoice value, and handling fee. The parser needs an explicit invoice-level fee model.'],
    ['Blinkit/Hyperpure layout','Each product can be followed by a “Delivery and other charges” row. Associate that charge with the preceding product internally, but do not list it as a grocery item in the review UI.'],
    ['Discounts and tax','Both families expose discount and tax values. Use the invoice’s final item total as the splitting amount; make any fee allocation visible and editable.'],
    ['Duplicate PDFs','Fingerprint PDFs/order IDs on import and warn before creating a second purchase record.'],
    ['Privacy','These PDFs contain names, addresses, order IDs, and purchase history. For a personal v0, parse them in memory and keep only minimum ledger fields; cross-device sync is an explicit later decision.'],
], [1.45,5.25])
add_body(doc,'Validated parser output for each purchase: merchant/template, invoice/order ID, invoice date, currency (INR), raw line items, quantity/unit, product total, product-linked delivery charge where present, invoice-level fee, grand total, and an extraction confidence/review status. Tax breakdown can be retained for audit, but is not required in the primary splitting interface.', 'Recommended record: ')

add_heading(doc,'What exists today',1)
add_table(doc,['Product','Strong overlap','Free?','Critical gap versus your idea'],[
    ['Tricount','Shared household expenses; equal, percentage, and custom splits; settle-up suggestions.','Yes—claims no fees, ads, or limits.','No item-level grocery record or consumption/replenishment intelligence.'],
    ['Splitwise','Receipt image scanning and detected line items assigned among people.','Core app free; receipt scanning/itemization is Pro.','Tracks debts, not household inventory or use rate.'],
    ['Grocy','Open-source, self-hosted pantry/stock, minimum-stock shopping list, expiry, barcode lookup, recipes.','Software is free/open source; self-hosting effort remains.','No native shared-expense/receipt-splitting focus; data entry remains a hurdle.'],
    ['Pantry Check','Barcode-led inventory, expiry alerts, restock suggestions, price tally.','Free tier: up to 200 inventory items.','No shared-bill settlement or receipt-driven household allocation.'],
    ['NoWaste','Pantry/fridge/freezer lists, expiry tracking, barcode/photo recognition, shopping/meal planning.','Free status/limits not established from its public site.','No shared payment ledger or item responsibility model.'],
], [1.1,2.25,1.1,2.25])
add_body(doc,'The workflow is fragmented, not absent. A user can pair Tricount with Grocy today, but that creates duplicate entry and no single audit trail from receipt → ownership → stock → consumption → next purchase.', 'Interpretation: ')

add_heading(doc,'Where the idea can win—and where it will struggle',1)
add_table(doc,['Assessment','Evidence-based view'],[
    ['Real user value','High for roommates, couples, or families who repeatedly buy mixed/shared groceries and argue over fairness or forget staples. The receipt is a natural “moment of truth” for expense entry.'],
    ['Differentiation','Moderate only if the workflow is integrated. “Receipt OCR + splitting” alone is already a paid Splitwise feature. “Inventory + restock alerts” is covered by Grocy and pantry apps.'],
    ['Hard problem','Consumption is largely invisible. A receipt proves a purchase, not who used it, how fast it is consumed, whether it was discarded, or whether it was a one-off. Predictions must begin as suggestions with confidence and confirmation.'],
    ['Adoption risk','High if every purchase requires item cleanup, quantities, units, ownership, and stock location. The product must allow a fast path and only request corrections that improve later recommendations.'],
    ['Privacy/trust','Receipts expose store, date, payment totals, purchases, and household behavior. Data minimization, clear sharing controls, and an explicit correction history are product requirements—not later polish.'],
], [1.45,5.25])

add_heading(doc,'A sharper product thesis',1)
add_body(doc,'“The shared pantry and expense ledger for a household.” It is not primarily an expense app, and not primarily a pantry app. Its job is to make the recurring shared-grocery loop fair and automatic enough that people actually keep using it.', 'Suggested positioning: ')
add_bullet(doc,'Receipt-first capture: upload a photo/PDF; extract merchant, date, totals, tax/discounts, and line items; always show an editable review screen.')
add_bullet(doc,'Item-level split rules: private, shared equally, shared by selected people, or a saved household rule. Allocate discount/tax/fees transparently and keep an editable ledger record, not the original receipt.')
add_bullet(doc,'Inventory only for repeatable shared staples at first—not every item. Let a household mark an item “track for restock” after it appears more than once.')
add_bullet(doc,'Prediction as a recommendation, never a silent automatic order: “Milk is likely due in 3–5 days; add to list?” Show why and let users confirm, snooze, or dismiss.')
add_bullet(doc,'A shared, exportable audit trail: purchase, split, settlement status, inventory adjustment, and recommendation outcome.')

add_heading(doc,'Recommended discovery scope (not a build plan)',1)
add_table(doc,['Phase','Smallest useful test','What it tells you'],[
    ['1. Problem interviews','Speak to 8–12 households in one chosen segment. Ask them to walk through their last two grocery purchases and show their current workaround.','Whether the pain is frequent, costly, and shared—not merely interesting.'],
    ['2. Concierge trial','Manually process 20–30 receipts for 3–5 households into a simple shared ledger and send proposed restock messages.','Which receipt fields, split rules, and reminders people correct or value.'],
    ['3. Narrow prototype','Receipt review + item-level split + household balance + manually curated shared staples. No forecasting promise yet.','Whether the input workflow earns repeat usage.'],
    ['4. Evidence-based reminders','For items with enough confirmed history, show a predicted purchase window and capture outcomes.','Whether prediction improves shopping behavior enough to retain users.'],
], [1.1,2.85,2.75])

add_heading(doc,'Non-negotiable product principles',1)
add_bullet(doc,'Receipt extraction is a draft, never the source of truth. Preserve line-item confidence and require review for low-confidence fields.')
add_bullet(doc,'Keep “who paid” separate from “who consumed/owns.” These are often different for groceries.')
add_bullet(doc,'Make discounts, tax, delivery, bags, deposits, and rounding explainable at line-item level. Hidden allocation will break trust.')
add_bullet(doc,'Support a “do not track inventory” choice per item. Produce is consumed/variable; detergent is a better early replenishment candidate.')
add_bullet(doc,'Notifications should be opt-in, rate-limited, and household-aware. One person should not be pinged for an item another person just bought.')

add_heading(doc,'Implementation status — 12 July 2026',1)
add_body(doc,'A native SwiftUI iPhone project named GroceryLedger now exists in this project hub. It uses SwiftData for local storage, PDFKit for selectable-text PDF reading, and a three-tab interface for the dashboard, purchases, and balances. The iPhone SDK build completed successfully with the local project source.')
add_bullet(doc,'Implemented: PDF selection; Instamart and Blinkit/Zomato Hyperpure detection; invoice-buyer detection (Ekta or Ritesh); local ledger storage without raw receipt retention; equal Ekta/Ritesh split; per-item personal-item exclusion; a local balance calculation; and manual settlement records.', 9.5)
add_bullet(doc,'The importer reads a chosen PDF in memory, extracts product candidates, and asks the user to verify them before saving. It does not silently create purchases from receipt text, does not retain the source PDF, and disables saving when the detected invoice number already exists.', 9.5)
add_bullet(doc,'Implemented correction: each repeat item uses the interval between its latest two distinct purchase dates, rather than averaging sparse history. If duplicate same-day imports are detected, forecasting is withheld until the history is cleaned up. With enough clean purchases, a later version can show a robust range/median, labelled as an estimate. Repeated items are surfaced as “possible buys” immediately; they are not claims that stock has run out.', 9)
add_bullet(doc,'Implemented estimate field: invoices rarely contain expiry dates, so manual grocery/household purchases may carry an optional estimated use-by date. It is visibly labelled as an estimate and is not inferred from the receipt. Barcode/product-data lookup and package-label scanning remain later sources; fresh produce is especially uncertain.', 9)
add_bullet(doc,'Implemented shared-expense expansion: manual entry now supports Groceries, Food, Wi-Fi, Water, Household, and Other; it uses the same local Ekta/Ritesh ledger and personal-item correction model. The supplied Zomato summary is parsed as a Food purchase: La Pino\'z Pizza, the order time, five line items, and ₹674.88 were verified by the parser harness.', 9)
add_bullet(doc,'Documentation: Grocery_Change_Log.docx records dated changes, rationale, verification, and limits. Both project documents are updated whenever a material change is made; no automatic documentation schedule is active.', 9)
add_bullet(doc,'Privacy decision: do not store raw PDFs, addresses, customer names, payment method/instrument details, payment references, or payment status. PDFs are read in memory only during import; retain only the local ledger fields needed for splitting and suggestions. The legacy simulator data was cleared on 12 July 2026; the original source PDFs remain in Downloads. Any simulator Files copies are temporary import staging and must be removed after review. The explicit iOS Files-sharing manifest is verified enabled for this staging path.', 9)
add_bullet(doc,'Reliability correction: the v0 SwiftData model now gives the later-added purchase category a migration default of “Groceries.” This preserves existing local records when the app schema changes. The repair was verified with the eight stored simulator purchases, a migrated database schema inspection, the live dashboard, and an isolated save/fetch check.', 9)
add_bullet(doc,'Run on iPhone: open GroceryLedger.xcodeproj in Xcode, select the GroceryLedger target, choose your Apple Development Team under Signing & Capabilities, select your connected iPhone, then press Run. The app is intentionally not configured to collect money or sync data.', 9.5)
add_body(doc,'The automated compile used the iPhone SDK. Simulator launch could not be exercised from this sandbox because its local simulator service is unavailable here; validate the interface on your connected iPhone in Xcode.', 'Verification note: ')
add_heading(doc,'Implementation update — 12 July 2026, 20:43 IST',2)
add_body(doc,'A dedicated SwiftData persistence harness now exists at Tools/VerifyPersistence.swift. It spins up an in-memory model container, saves a purchase with an item, fetches it back, and asserts that the new category field and item relationship persist correctly.', 'What changed: ')
add_body(doc,'This matters because the project is evolving its local ledger schema quickly. A small, explicit persistence check is better evidence than relying only on UI behavior after a migration fix, and it gives future documentation updates a concrete verification reference.', 'Why it matters: ')
add_body(doc,'The harness source is present and aligned with the migration-default repair. This automation run could not execute the SwiftData macro toolchain from the sandbox, so the harness remains a verified artifact by inspection and still needs normal local execution outside this environment.', 'Verification and limit: ')

add_heading(doc,'Implementation update — 13 July 2026, 11:56 IST',2)
add_body(doc,'The native app now has configurable local restock reminders: Off, Daily, or Weekly, with a user-chosen time and weekday. The message is deliberately generic (“review possible buys”), because the app cannot truthfully state that an item has definitely run out. User-entered estimated use-by dates are labelled estimates and take precedence over a derived purchase interval.', 'Reminder and prediction policy: ')
add_body(doc,'The restock calculation is now constrained to explicitly tracked, non-personal Grocery or Household items. Food orders are retained for shared balances but are excluded from grocery restock evidence. The latest two distinct buying dates remain the first cadence cue; repeated same-day records withhold forecasting.', 'Data-quality improvement: ')
add_body(doc,'A real XCTest target now verifies seven edge cases on iPhone Simulator: personal-item split exclusion, settlement safety when purchases are absent, last-two-date cadence, estimated-use-by precedence, Food/untracked exclusion, sanitised food-order parsing, and no raw-PDF persistence by default. Both the iOS app build and the full simulator test run passed on 13 July 2026.', 'Verification: ')
add_body(doc,'A browser-local testing version now exists under web/. It supports manual shared expenses, personal-item exclusion, balances, settlements, possible-buy cues, demo data, and clear-local-data. It deliberately does not accept receipt uploads: GitHub Pages is a static public test surface and the privacy rule prohibits storing raw receipts there. The web build and privacy/control test passed.', 'Web testing version: ')
add_body(doc,'A GitHub Pages deployment package is now prepared under docs/ with an Actions workflow under .github/workflows/pages.yml. This standalone static build provides the same manual-ledger test path and stores data only in each tester’s browser. It is ready to publish after the actual project root is connected to the GitHub repository; the accidental empty nested repository must not receive the project files.', 'Sharing path: ')
add_body(doc,'The static tester is now live at https://ektadhan.github.io/359/. It is intentionally a manual-entry test surface: it gives external testers a safe way to exercise balance, settlement, personal-item, and restock-cue behaviour without uploading a receipt or sharing financial/address information. The repository is public only because GitHub Pages required it on the account plan in use; the deployed implementation remains browser-local.', 'Live testing status: ')
add_body(doc,'A browser-validation defect was found during live testing: the settlement form retained the hidden required purchase label, causing the browser to block Save. The static implementation now toggles that requirement by entry type. The repaired flow was verified with a Rs 300 settlement against demo data, reducing the displayed outstanding balance from Rs 367 to Rs 67. This fix is pending its follow-up commit and Pages redeployment.', 'Post-deployment correction: ')
add_body(doc,'The same native validation path also blocked Close and Cancel. Both controls now bypass submission explicitly. Local verification opened the settlement dialog, closed it, reopened it, and cancelled it; each action dismissed the dialog successfully. This closes the core browser-dialog defect before the next public deployment.', 'Dialog resilience: ')
add_body(doc,'The product now requires multi-device shared use: Ekta and Ritesh must see and update the same ledger from their own devices. The selected path is Supabase Free behind the GitHub Pages client, using passwordless email magic links or one-time codes and a shared-household access model. A static site alone cannot satisfy this requirement because browser-local data cannot synchronise.', 'Shared sync decision: ')
add_body(doc,'The backend data contract is intentionally narrow: auth identity, household membership, reviewed purchases, personal-item flags, settlements, and restock settings. Excluded data: raw invoices, address, payment mode, card/UPI/bank detail, and payment references. Row Level Security is mandatory; a public client may use only the publishable/anon key, never a service-role key.', 'Security boundary: ')
add_body(doc,'A first-pass Supabase schema is prepared in supabase/schema.sql. It uses an invite-code household join flow, membership-scoped Row Level Security policies, and Supabase Realtime registration for purchases, settlements, and membership changes. It must be applied in the owner-controlled SQL Editor before the public website receives its project URL and publishable key configuration.', 'Implementation readiness: ')
add_body(doc,'The static web client is now configured for the provisioned Supabase project using only its publishable browser key. It offers magic-link email sign-in, household creation or invite-code joining, backend-backed purchases and settlements, and Realtime refresh. The client never receives a database password or service-role key. Authentication redirect configuration and two-device signed-in verification remain the pre-publication gate.', 'Shared client status: ')
add_body(doc,'Security Advisor correctly flagged PostgreSQL’s default function EXECUTE grants. The follow-up hardening migration removes public/anonymous execution, moves the membership helper to a non-exposed private schema, uses fixed empty search paths with fully-qualified table references, and grants browser invocation only to authenticated household-create and invite-join RPCs. Security Advisor may still note those two guarded SECURITY DEFINER RPCs because they must be callable by signed-in people; their use is bounded by auth identity, explicit permissions, and RLS. The project owner must run supabase/harden-function-permissions.sql once and recheck the Advisor before the two-device test.', 'Security hardening update — 13 July 2026, 14:28 IST: ')
add_body(doc,'The project selected the default magic-link flow because the Supabase Free project does not permit editing the default email template without custom SMTP. A magic link creates a session in the browser that consumes it; this is an authentication boundary, not a ledger restriction. The sign-in UI now explicitly tells the user to copy the unconsumed email link and paste it into the address bar of the chosen browser before opening it. This supports any browser without SMTP cost, passwords, or extra stored data. A code-entry flow remains a later option only if the project explicitly adopts a custom SMTP provider.', 'Cross-browser sign-in update — 13 July 2026, 15:15 IST: ')
add_body(doc,'Live two-Mac testing exposed two implementation gaps: the sign-in request lacked visible in-context feedback, and the authenticated role lacked table-level privileges needed for the Data API to begin RLS evaluation of household membership. The repair gives the sign-in panel clear Sending/Sent/error feedback and grants only the minimum authenticated table operations for membership reads, reviewed-purchase reads/writes, and settlement reads/writes. Row Level Security remains the row-level enforcement layer; no anonymous access, receipt data, payment data, addresses, or additional profile fields are introduced. The owner must run supabase/grant-ledger-table-access.sql before repeating the shared test.', 'Live shared-sync repair — 13 July 2026, 15:35 IST: ')

doc.add_page_break()
add_heading(doc,'Source notes',1)
add_body(doc,'Research checked on 11 July 2026 and implementation status refreshed through 12 July 2026. Product claims below are drawn from vendors’/projects’ official public pages and may change; pricing/feature availability should be rechecked when selecting competitors for implementation.')
sources=[
    ('Expense splitting — Tricount', 'https://tricount.com/en-in/ | https://tricount.com/expense-tracker-features', 'Free shared-expense positioning; household use and custom splits.'),
    ('Receipt splitting — Splitwise', 'https://www.splitwise.com/pro | https://www.splitwise.com/subscriptions/new', 'Receipt scan/itemization and its Pro subscription positioning.'),
    ('Household inventory — Grocy', 'https://grocy.info/', 'Open-source stock, minimum-stock shopping lists, barcodes, recipes, and expiry workflows.'),
    ('Consumer pantry apps — Pantry Check & NoWaste', 'https://pantrycheck.com/ | https://pantrycheck.com/kb/add-items-screen/ | https://www.nowasteapp.com/', 'Inventory/expiry/restock capabilities and Pantry Check’s stated 200-item free tier.'),
]
for name,url,note in sources:
    p=doc.add_paragraph(); p.paragraph_format.space_after=Pt(3); p.paragraph_format.line_spacing=1.0
    r=p.add_run(name + ' — '); set_font(r,7.5,True,(31,77,120)); r=p.add_run(note + ' ' + url); set_font(r,7.5,False,(70,70,70))

doc.save(OUT)
print(OUT)
