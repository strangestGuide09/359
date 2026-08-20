import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("Escape closes a plain Add expense dialog and restores its invoking control", () => {
  assert.match(app, /function openEntry\(next,[\s\S]*entryInvoker = document\.activeElement instanceof HTMLElement/);
  assert.match(app, /dialog\.addEventListener\("keydown", event => \{[\s\S]*event\.key !== "Escape"[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);[\s\S]*closeEntry\(\);/);
  assert.match(app, /dialog\.close\(\);[\s\S]*const returnTarget = entryInvoker;[\s\S]*returnTarget\.focus\(\)/);
  assert.match(app, /\$\("add"\)\.onclick = \(\) => openEntry\("expense"\)/);
});

test("Escape from import review and saved item edit uses the safe draft confirmation", () => {
  assert.match(app, /openEntry\("expense", processed\.defaults, processed\)/);
  assert.match(app, /openEntry\("edit",[\s\S]*savedEdit: true/);
  assert.match(app, /function requestDiscardPdfDraft\(\) \{[\s\S]*if \(!pendingPdfImport\) \{ finishCloseEntry\(\); return; \}[\s\S]*discardPdfDraftDialog\.showModal\(\)/);
  assert.match(app, /discardPdfDraftDialog\.addEventListener\("keydown", event => \{[\s\S]*event\.key !== "Escape"[\s\S]*keepEditingPdfDraft\(\);/);
});

test("Escape handling is scoped to open dialogs rather than document inputs", () => {
  assert.doesNotMatch(app, /document\.addEventListener\("keydown"/);
  assert.match(app, /event\.key !== "Escape" \|\| !dialog\.open/);
  assert.match(app, /event\.key !== "Escape" \|\| !discardPdfDraftDialog\.open/);
});
