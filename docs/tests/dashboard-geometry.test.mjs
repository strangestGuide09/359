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
async function measure(page, state, presentation = "classic") {
  await page.goto(`${origin}/tests/fixtures/dashboard-geometry.html?state=${state}&presentation=${presentation}`);
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
    if (state === "settings") Object.assign(result, { settingsProfile: rect(".settings-profile"), settingsAccount: rect(".settings-account"), settingsBody: rect(".settings-body") });
    return result;
  }, state);
}

test("loading and auth footers align to their active narrow cards", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  for (const presentation of ["classic", "sketch"]) for (const state of ["loading", "auth"]) {
    const measured = await measure(page, state, presentation);
    assert.deepEqual(edges(measured.footer), edges(measured.card), `${presentation} ${state}`);
  }
  await page.close();
});

test("dashboard and expanded settings share exact desktop edges and intentional insight geometry", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  for (const presentation of ["classic", "sketch"]) for (const state of ["dashboard", "settings"]) {
    const measured = await measure(page, state, presentation);
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
  for (const presentation of ["classic", "sketch"]) for (const viewport of [{ width: 820, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const measured = await measure(page, "dashboard", presentation);
    assert.equal(measured.scrollWidth, measured.viewport);
    assert.ok(measured.masthead.top < measured.command.top);
    assert.ok(measured.command.top < measured.insights.top);
    assert.ok(measured.insights.top < measured.ledger.top);
    assert.ok(measured.ledger.top < measured.settings.top);
    await page.close();
  }
});

test("open settings use compact columns on desktop and stack cleanly on mobile", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  for (const presentation of ["classic", "sketch"]) for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const measured = await measure(page, "settings", presentation);
    assert.equal(measured.scrollWidth, measured.viewport);
    if (viewport.width > 700) {
      assert.equal(Math.round(measured.settingsProfile.top), Math.round(measured.settingsAccount.top));
      assert.ok(measured.settingsProfile.right < measured.settingsAccount.left);
    } else {
      assert.ok(measured.settingsProfile.bottom < measured.settingsAccount.top);
      assert.ok(measured.settingsProfile.width > viewport.width - 60);
    }
    await page.close();
  }
});

test("Possible Buys guidance wraps naturally within its card", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${origin}/tests/fixtures/dashboard-geometry.html?state=dashboard`);
    const measured = await page.evaluate(() => {
      const panel = document.querySelector(".restock-panel");
      panel.insertAdjacentHTML("beforeend", '<div class="restock-empty"><b>Buy a tracked item again to unlock suggestions</b><p>Tracking 14 grocery item types across 1 purchase date. Possible Buys needs the same item on 2 different dates.</p><details><summary>Why nothing is showing yet</summary><p>Excluded fee, tax, delivery, personal and untracked lines.</p></details></div>');
      const empty = panel.querySelector(".restock-empty").getBoundingClientRect();
      const paragraph = panel.querySelector(".restock-empty>p");
      const style = getComputedStyle(paragraph);
      return { empty, panel: panel.getBoundingClientRect(), scrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, letterSpacing: style.letterSpacing, transform: style.textTransform };
    });
    assert.ok(measured.empty.left >= measured.panel.left);
    assert.ok(measured.empty.right <= measured.panel.right);
    assert.equal(measured.scrollWidth, measured.viewport);
    assert.equal(measured.letterSpacing, "normal");
    assert.equal(measured.transform, "none");
    await page.close();
  }
});

test("native expense selects align, stack, and retain chevrons in both presentations", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  for (const presentation of ["classic", "sketch"]) for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${origin}/tests/fixtures/dashboard-geometry.html?state=dashboard&presentation=${presentation}&modal=1`);
    const measured = await page.evaluate(() => {
      const category = document.querySelector("#fixture-category").getBoundingClientRect();
      const payer = document.querySelector("#fixture-payer").getBoundingClientRect();
      const payerStyle = getComputedStyle(document.querySelector("#fixture-payer"));
      return { category, payer, columns: getComputedStyle(document.querySelector(".expense-meta-grid")).gridTemplateColumns, appearance: payerStyle.appearance, background: payerStyle.backgroundImage, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert.equal(measured.category.height, 48);
    assert.equal(measured.payer.height, 48);
    assert.equal(measured.appearance, "none");
    assert.match(measured.background, /linear-gradient/);
    assert.equal(measured.overflow, 0);
    if (viewport.width > 700) assert.equal(Math.round(measured.category.top), Math.round(measured.payer.top));
    else assert.ok(measured.category.bottom < measured.payer.top);
    await page.close();
  }
});
