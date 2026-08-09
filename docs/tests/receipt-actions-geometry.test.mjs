import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

let chromium;
try { ({ chromium } = await import("playwright")); } catch {
  const modules = process.env.NODE_PATH?.split(delimiter).find(Boolean);
  if (modules) try { ({ chromium } = await import(pathToFileURL(join(modules, "playwright/index.mjs")))); } catch {}
}

const root = new URL("../", import.meta.url).pathname;
let server, origin, browser;
test.before(async () => {
  if (!chromium) return;
  server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname.replace(/^\//, "");
    try { const body = await readFile(join(root, path)); response.setHeader("content-type", extname(path) === ".css" ? "text/css" : "text/html"); response.end(body); }
    catch { response.statusCode = 404; response.end("Not found"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try { browser = await chromium.launch({ headless: true }); } catch { browser = undefined; }
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

test("receipt amount and action columns align without overflow at desktop, tablet, and mobile", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${origin}/tests/fixtures/receipt-actions-geometry.html`);
    const measured = await page.evaluate(() => {
      const rects = selector => [...document.querySelectorAll(selector)].map(node => node.getBoundingClientRect().toJSON());
      const buttonHeights = rects(".receipt-action-buttons button").map(box => Math.round(box.height));
      const first = [...document.querySelector(".purchase-row").children].map(node => node.getBoundingClientRect().toJSON());
      return { viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, headers: rects(".ledger-columns>span"), first, headerDisplay: getComputedStyle(document.querySelector(".ledger-columns")).display, buttonHeights };
    });
    assert.equal(measured.scrollWidth, measured.viewport);
    if (viewport.width > 900) {
      assert.equal(measured.headers.length, 6);
      assert.equal(measured.first.length, 6);
      measured.headers.forEach((header, index) => assert.ok(Math.abs(header.left - measured.first[index].left) <= 1));
    } else if (viewport.width <= 700) {
      assert.equal(measured.headerDisplay, "none");
      assert.ok(measured.buttonHeights.every(height => height >= 43));
    }
    await page.close();
  }
});
