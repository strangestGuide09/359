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
  assert.match(app, /visualPlan:\s*planVisualDerivative\(\{ pages: imported\.pages, pageSizes: imported\.pageSizes, merchant: parsed\.defaults\.label \}\)/);
  assert.doesNotMatch(app, /const rows = new Map\(\)/);
  assert.doesNotMatch(app, /p_(?:pdf|raw|extracted|receipt_text)/i);
});

test("safe visual tables use vendor recognition or one local approval before AI submission", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /visualPlan\.known \|\| hasRememberedVisualLayout\(prepared\.layoutKey\)/);
  assert.match(app, /openVisualAiPreview\(prepared\)/);
  assert.match(app, /rememberVisualLayout\(prepared\.layoutKey\)/);
  assert.match(app, /openTextAiPreview\(\)/);
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
  assert.match(app, /Private AI processing; the original receipt remains on this device/);
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
  assert.match(inspection, /openTextAiPreview\(processed\)/);
  assert.match(inspection, /Nothing was sent or stored/);
  assert.doesNotMatch(inspection, /submitAiDerivative|fetch\(/);
  assert.match(app, /preparedVisualDerivative\?\.layoutKey === visualPlan\.layoutKey[\s\S]*preparedVisualDerivative[\s\S]*submitAiDerivative/);
  assert.match(inspection, /createFlattenedVisualDerivative\(pdfjsLib, processed\.sourcePdfBytes, processed\.visualPlan\)/);
  assert.match(app, /function returnToImportChoice\(\)[\s\S]*importChoiceDialog\.showModal\(\)/);
});

test("an unknown receipt total is not rendered as zero or a negative difference", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /Receipt total: needs confirmation · Difference unavailable/);
  assert.match(app, /if \(!rawReceiptTotal\)/);
  assert.doesNotMatch(app, /const receiptTotal = Number\(\$\("amount"\)\.value\) \|\| 0/);
});
