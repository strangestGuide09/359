import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { purchaseDateTimeline } from "../purchase-timeline.js";

test("timeline follows purchase dates across upload gaps", () => {
  const purchases = [
    { id: "instamart", purchased_on: "2026-07-03", created_at: "2026-08-13T09:00:00Z" },
    { id: "blinkit", purchased_on: "2026-08-13", created_at: "2026-08-13T10:00:00Z" }
  ];
  const timeline = purchaseDateTimeline(purchases);
  assert.deepEqual(timeline.dates.map(item => [item.date, item.receiptCount]), [["2026-07-03", 1], ["2026-08-13", 1]]);
  assert.equal(timeline.dates[1].gapDays, 41);
  assert.equal(timeline.selectedDate, "2026-08-13");
  assert.equal(timeline.previousDate, "2026-07-03");
  assert.equal(purchaseDateTimeline(purchases, "2026-07-03").nextDate, "2026-08-13");
});

test("multiple uploads on one purchase date count once in navigation", () => {
  const timeline = purchaseDateTimeline([{ purchased_on: "2026-07-03" }, { purchased_on: "2026-07-03" }]);
  assert.equal(timeline.dates.length, 1);
  assert.equal(timeline.dates[0].receiptCount, 2);
});

test("home explains purchase-date chronology and does not duplicate receipts", async () => {
  const [app, style] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../style.css", import.meta.url), "utf8")
  ]);
  assert.match(app, /Scroll through actual purchase dates\. Upload day does not change receipt chronology/);
  assert.match(app, /Purchase-dated receipts and linked payments/);
  assert.match(app, /Uploaded \$\{fmt\(uploaded\)\}/);
  assert.doesNotMatch(app, /function renderOpenReceipts/);
  assert.match(app, /const needsAttention = renderNeedsAttention\(balance, archived\)/);
  assert.match(style, /\.purchase-date-strip/);
  assert.match(style, /\.rhythm-record-grid\.has-attention/);
});

test("balance action is a compact single-purpose payment control", async () => {
  const [app, style] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../style.css", import.meta.url), "utf8")
  ]);
  assert.match(app, />Record payment<\/button>/);
  assert.match(app, /<b>Next action<\/b>/);
  assert.match(style, /\.balance-next button \{[^}]*white-space:nowrap/);
  assert.match(style, /\.balance-card \{ display:grid;/);
});
