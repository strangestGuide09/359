import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasUnsafeDraft, versionAction } from "../version-check.js";

test("new static build auto-reloads only when the page is safe", () => {
  assert.equal(versionAction("old", "new", false, ""), "reload");
  assert.equal(versionAction("old", "new", true, ""), "prompt");
  assert.equal(versionAction("new", "new", false, ""), "none");
});

test("open dialogs, PDF drafts, and edited forms protect user work", () => {
  assert.equal(hasUnsafeDraft({ dialogOpen: true, pendingPdfImport: false, formDirty: false }), true);
  assert.equal(hasUnsafeDraft({ dialogOpen: false, pendingPdfImport: true, formDirty: false }), true);
  assert.equal(hasUnsafeDraft({ dialogOpen: false, pendingPdfImport: false, formDirty: true }), true);
  assert.equal(hasUnsafeDraft({ dialogOpen: false, pendingPdfImport: false, formDirty: false }), false);
});

test("a repeated reload token is prompted instead of causing a loop", () => {
  assert.equal(versionAction("old", "new", false, "new"), "prompt");
});

test("Pages artifact embeds one SHA while polling a separately cache-busted version resource", async () => {
  const root = new URL("../../", import.meta.url);
  const [workflow, page, app] = await Promise.all([
    readFile(new URL(".github/workflows/pages.yml", root), "utf8"),
    readFile(new URL("docs/index.html", root), "utf8"),
    readFile(new URL("docs/app.js", root), "utf8")
  ]);
  assert.match(workflow, /GROCERY_LEDGER_BUILD/);
  assert.match(workflow, /version\.json/);
  assert.match(workflow, /version\.js\?v=\$\{GITHUB_SHA\}/);
  assert.match(workflow, /path: _site/);
  assert.match(page, /<script src="version\.js"><\/script>/);
  assert.match(app, /versionUrl\.searchParams\.set\("t", Date\.now\(\)\)/);
  assert.match(app, /fetch\(versionUrl, \{ cache: "no-store" \}\)/);
});
