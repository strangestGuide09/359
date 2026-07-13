import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("web app has the required local-first, privacy-preserving controls", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /localStorage/);
  assert.match(page, /Receipt PDFs are not uploaded or saved here/);
  assert.match(page, /Personal item — exclude from split/);
  assert.match(page, /Record settlement/);
  assert.match(page, /Possible buys/);
  assert.match(layout, /Grocery Ledger — Shared bills/);
  assert.match(layout, /og\.png/);
  assert.match(css, /--pine/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
