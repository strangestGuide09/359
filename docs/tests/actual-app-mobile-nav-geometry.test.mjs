import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createMockAuthenticatedAppServer } from "./mock-authenticated-app-server.mjs";

let chromium;
try { ({ chromium } = await import("playwright")); } catch {
  const modules = process.env.NODE_PATH?.split(delimiter).find(Boolean);
  if (modules) try { ({ chromium } = await import(pathToFileURL(join(modules, "playwright/index.mjs")))); } catch {}
}

let server, origin, browser;
test.before(async () => {
  if (!chromium) return;
  server = createMockAuthenticatedAppServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try { browser = await chromium.launch({ headless: true }); } catch { browser = undefined; }
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

test("390px actual authenticated app keeps every focused ledger action clear of fixed navigation", async context => {
  if (!browser) return context.skip("Playwright browser executable is not installed");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(origin);
  await page.waitForSelector(".command-actions");
  const selectors = ["#settle", "#import-pdf", "#add", "#open-settings"];
  const results = [];
  for (const selector of selectors) {
    await page.locator(selector).evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.locator(selector).focus();
    results.push(await page.evaluate(target => {
      const action = document.querySelector(target).getBoundingClientRect();
      const nav = document.querySelector(".app-navigation").getBoundingClientRect();
      return { target, actionTop: action.top, actionBottom: action.bottom, navTop: nav.top, navBottom: nav.bottom, height: action.height, pageWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth };
    }, selector));
  }
  assert.ok(results.every(result => result.actionBottom <= result.navTop), JSON.stringify(results));
  assert.ok(results.every(result => result.height >= 43));
  assert.ok(results.every(result => result.scrollWidth === result.pageWidth));
  await page.close();
});
