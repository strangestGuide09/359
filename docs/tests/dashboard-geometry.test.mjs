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
let server;
let origin;
let browser;

test.before(async () => {
  if (!chromium) return;
  server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname.replace(/^\//, "");
    try {
      const body = await readFile(join(root, path));
      response.setHeader("content-type", extname(path) === ".css" ? "text/css" : "text/html");
      response.end(body);
    } catch { response.statusCode = 404; response.end("Not found"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try { browser = await chromium.launch({ headless: true }); } catch { browser = undefined; }
});

test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

const edges = box => ({ left: Math.round(box.left), right: Math.round(box.right) });
async function measure(page, state) {
  await page.goto(`${origin}/tests/fixtures/dashboard-geometry.html?state=${state}`);
  return page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const result = { viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, footer: rect(".page-meta") };
    if (state === "loading" || state === "auth") result.card = rect(state === "loading" ? ".state-panel" : ".account-gate");
    else Object.assign(result, {
      shell: rect(".dashboard-shell"),
      masthead: rect(".household-masthead"),
      mastheadBorder: getComputedStyle(document.querySelector(".household-masthead")).borderTopWidth,
      members: [...document.querySelectorAll(".member-block")].map(member => member.getBoundingClientRect().toJSON()),
      command: rect(".command-bar"),
      insights: rect(".insights-grid"),
      restock: rect(".restock-panel"),
      settlements: rect(".settlements-panel"),
      ledger: rect(".expenses-panel"),
      settings: rect(".settings")
    });
    return result;
  }, state);
}

test("loading and auth footers align to their active narrow cards", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  for (const state of ["loading", "auth"]) {
    const measured = await measure(page, state);
    assert.deepEqual(edges(measured.footer), edges(measured.card));
  }
  await page.close();
});

test("dashboard and expanded settings share exact desktop edges and intentional insight geometry", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  for (const state of ["dashboard", "settings"]) {
    const measured = await measure(page, state);
    for (const key of ["masthead", "command", "insights", "ledger", "settings", "footer"]) assert.deepEqual(edges(measured[key]), edges(measured.shell), key);
    assert.equal(Math.round(measured.restock.top), Math.round(measured.settlements.top));
    assert.equal(Math.round(measured.restock.bottom), Math.round(measured.settlements.bottom));
    assert.ok(measured.restock.width / measured.settlements.width > 1.8);
    assert.equal(measured.mastheadBorder, "0px");
    assert.ok(measured.members.every(member => member.height < 30));
    assert.equal(measured.scrollWidth, measured.viewport);
  }
  await page.close();
});

test("tablet and mobile retain order without horizontal overflow", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  for (const viewport of [{ width: 820, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const measured = await measure(page, "dashboard");
    assert.equal(measured.scrollWidth, measured.viewport);
    assert.ok(measured.masthead.top < measured.command.top);
    assert.ok(measured.command.top < measured.insights.top);
    assert.ok(measured.insights.top < measured.ledger.top);
    assert.ok(measured.ledger.top < measured.settings.top);
    await page.close();
  }
});
