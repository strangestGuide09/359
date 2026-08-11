import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("PDF draft discard uses an accessible in-app confirmation", async () => {
  const [page, style] = await Promise.all([read("docs/index.html"), read("docs/style.css")]);
  assert.match(page, /<dialog id="discard-pdf-draft"[^>]*aria-labelledby="discard-pdf-draft-title"[^>]*aria-describedby="discard-pdf-draft-copy"/);
  assert.match(page, /<h2 id="discard-pdf-draft-title">Discard this receipt draft\?<\/h2>/);
  assert.match(page, /Nothing was saved or uploaded\.[^<]*local PDF and extracted receipt text/);
  assert.match(page, /id="keep-pdf-draft"[^>]*class="secondary"[^>]*>Keep editing<\/button>/);
  assert.match(page, /id="confirm-discard-pdf-draft"[^>]*class="danger"[^>]*>Discard draft<\/button>/);
  assert.match(style, /\.discard-draft-dialog \{ width:min\(520px,calc\(100% - 30px\)\); \}/);
});

test("safe dismissal keeps editing while confirmed discard uses existing cleanup", async () => {
  const app = await read("docs/app.js");
  assert.doesNotMatch(app, /confirm\("Discard this local PDF draft/);
  assert.match(app, /function requestDiscardPdfDraft\(\) \{[\s\S]*discardPdfDraftDialog\.showModal\(\);[\s\S]*\$\("keep-pdf-draft"\)\.focus\(\)/);
  assert.match(app, /function keepEditingPdfDraft\(\) \{[\s\S]*discardPdfDraftDialog\.close\(\);[\s\S]*\$\("cancel"\)\.focus\(\)/);
  assert.match(app, /discardPdfDraftDialog\.addEventListener\("cancel", event => \{ event\.preventDefault\(\); keepEditingPdfDraft\(\); \}\)/);
  assert.match(app, /function confirmDiscardPdfDraft\(\) \{[\s\S]*discardPdfDraftDialog\.close\(\);[\s\S]*finishCloseEntry\(\);/);
  assert.match(app, /function finishCloseEntry\(\) \{[\s\S]*discardPreparedVisualDerivative\(\);[\s\S]*pendingPdfImport = undefined;[\s\S]*reviewedItems = \[\];[\s\S]*dialog\.close\(\);/);
});
