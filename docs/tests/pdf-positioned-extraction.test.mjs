import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("local PDF extraction preserves positioned tokens without persisting receipt text", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /page:\s*pageNumber/);
  assert.match(app, /x:\s*Number\(item\.transform\?\.\[4\]\)/);
  assert.match(app, /y:\s*Number\(item\.transform\?\.\[5\]\)/);
  assert.match(app, /width:\s*Number\(item\.width\)/);
  assert.match(app, /height:\s*Number\(item\.height\)/);
  assert.match(app, /sourcePdfBytes/);
  assert.match(app, /pageSizes\.push\(\{ width: viewport\.width, height: viewport\.height \}\)/);
  assert.match(app, /visualPlan:\s*planVisualDerivative\(\{ pages: imported\.pages, pageSizes: imported\.pageSizes, merchant: parsed\.defaults\.label, itemCount: parsed\.items\.length \}\)/);
  assert.doesNotMatch(app, /const rows = new Map\(\)/);
  assert.doesNotMatch(app, /p_(?:pdf|raw|extracted|receipt_text)/i);
});

test("safe visual tables use vendor recognition or one local approval before AI submission", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /visualPlan\.known \|\| hasRememberedVisualLayout\(prepared\.layoutKey\)/);
  assert.match(app, /openVisualAiPreview\(prepared\)/);
  assert.match(app, /rememberVisualLayout\(prepared\.layoutKey\)/);
  assert.match(app, /useLocalReviewAfterUnsafeVisual\(draftReference\)/);
  assert.doesNotMatch(app, /openTextAiPreview|sanitized-receipt\.pdf|buildSanitizedPdf/);
});

test("invoice processing is chosen before an editable review opens", async () => {
  const [app, page] = await Promise.all([read("docs/app.js"), read("docs/index.html")]);
  assert.match(page, /Choose how to process it/);
  assert.match(page, /Process locally/);
  assert.match(page, /Process with AI/);
  assert.match(app, /function processedPdfImport\(imported\)/);
  assert.match(app, /openImportChoice\(imported\)/);
  assert.match(app, /function startLocalPdfImport\(\)/);
  assert.match(app, /function startAiPdfImport\(\)/);
  assert.doesNotMatch(page, /Need help with a difficult receipt|class="ai-improve"|id="prepare-ai"/);
  assert.match(app, /selected processing method got wrong/);
  assert.match(app, /Only the original item-table pixels shown below will be sent/);
  assert.doesNotMatch(app, /Need help with a difficult receipt|Prepare private AI preview|local parser got wrong/);
  assert.match(app, /showImportProcessing\("ai"\)/);
  assert.match(app, /openEntry\("expense", draftReference\.defaults, draftReference\)/);
  assert.match(app, /pdfImport\?\.processedBy === "ai" \? "PRIVATE AI DRAFT"/);
  assert.match(app, /only the approved private derivative was processed by AI/);
  assert.ok(app.indexOf("openImportChoice(imported)") < app.lastIndexOf('openEntry("expense", draftReference.defaults, draftReference)'), "processing choice precedes AI review");
  assert.ok(app.indexOf("openImportChoice(imported)") < app.lastIndexOf('openEntry("expense", processed.defaults, processed)'), "processing choice precedes local review");
});

test("AI input inspection is local-only and reuses the exact prepared derivative", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /viewAiInputButton\.textContent = "View what AI receives"/);
  assert.match(app, /viewAiInputButton\.type = "button"/);
  assert.match(app, /function viewAiInput\(\)/);
  const inspection = app.slice(app.indexOf("async function viewAiInput()"), app.indexOf("viewAiInputButton.onclick"));
  assert.match(inspection, /createFlattenedVisualDerivative/);
  assert.match(inspection, /openVisualAiPreview\(prepared\)/);
  assert.match(inspection, /private visual item-table isolate could not be created safely/);
  assert.match(inspection, /Nothing was sent/);
  assert.doesNotMatch(inspection, /submitAiDerivative|fetch\(/);
  assert.match(app, /preparedVisualDerivative\?\.layoutKey === visualPlan\.layoutKey[\s\S]*preparedVisualDerivative[\s\S]*submitAiDerivative/);
  assert.match(inspection, /createFlattenedVisualDerivative\(pdfjsLib, processed\.sourcePdfBytes, processed\.visualPlan\)/);
  assert.match(app, /function returnToImportChoice\(\)[\s\S]*importChoiceDialog\.showModal\(\)/);
  assert.ok(app.indexOf("await submitAiDerivative") < app.indexOf("rememberVisualLayout(prepared.layoutKey)"), "approval is remembered only after submission succeeds");
});

test("visual derivatives mask the page and copy only approved original-pixel cells", async () => {
  const visual = await read("docs/ai-visual-derivative.js");
  assert.match(visual, /tableContext\.fillStyle = "#ffffff";[\s\S]*tableContext\.fillRect\(0, 0, sourceWidth, sourceHeight\)/);
  assert.match(visual, /for \(const cell of crop\.cells \|\| \[\]\)/);
  assert.match(visual, /pdf\.getPage\(crop\.pageNumber\)/, "omitted non-table pages do not shift source rendering");
  assert.match(visual, /tableContext\.drawImage\(fullPage, cellX, cellY, cellWidth, cellHeight/);
  assert.doesNotMatch(visual, /drawImage\(fullPage, sourceX, sourceY, sourceWidth, sourceHeight/);
  assert.doesNotMatch(visual, /cells\.push\(\{[^}]*text:/);
});

test("an unknown receipt total is not rendered as zero or a negative difference", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /Final total: needs confirmation · Difference unavailable/);
  assert.match(app, /if \(!rawReceiptTotal\)/);
  assert.doesNotMatch(app, /const receiptTotal = Number\(\$\("amount"\)\.value\) \|\| 0/);
});
