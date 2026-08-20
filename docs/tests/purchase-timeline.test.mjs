import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { householdRhythmTimeline, purchaseDateTimeline } from "../purchase-timeline.js";

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

test("household rhythm connects historical purchases to today and upcoming days", () => {
  const purchases = [{ purchased_on: "2026-07-03" }, { purchased_on: "2026-08-13" }];
  const timeline = householdRhythmTimeline(purchases, "2026-08-13");
  assert.deepEqual(timeline.dates.map(item => item.date), ["2026-07-03", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]);
  assert.equal(timeline.selectedDate, "2026-08-13");
  assert.equal(timeline.dates[1].isToday, true);
  assert.equal(timeline.dates[2].isFuture, true);
  assert.equal(timeline.dates[0].receiptCount, 1);
  assert.equal(timeline.dates[2].receiptCount, 0);
});

test("first render selects the latest receipt when today has no activity", () => {
  const timeline = householdRhythmTimeline([{ purchased_on: "2026-07-03" }, { purchased_on: "2026-08-13" }], "2026-08-20");
  assert.equal(timeline.selectedDate, "2026-08-13");
  assert.equal(householdRhythmTimeline([{ purchased_on: "2026-08-13" }], "2026-08-20", "2026-08-20").selectedDate, "2026-08-20");
});

test("home explains purchase-date chronology and does not duplicate receipts", async () => {
  const [app, homeView, style] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../home-rhythm-view.js", import.meta.url), "utf8"),
    readFile(new URL("../style.css", import.meta.url), "utf8")
  ]);
  assert.match(homeView, /Today and upcoming days show the household rhythm without changing receipt chronology/);
  assert.match(app, /Selected purchase date/);
  assert.match(app, /Uploaded \$\{fmt\(uploaded\)\}/);
  assert.doesNotMatch(app, /function renderOpenReceipts/);
  assert.doesNotMatch(app, /renderNeedsAttention/);
  assert.match(app, /This household has \$\{ledger\.purchases\.length\} receipt/);
  assert.match(app, /data-show-all-history/);
  assert.match(style, /\.purchase-date-strip/);
  assert.match(style, /\.purchase-date-strip\.is-sparse \.week-day \{ flex:1 1 180px/);
  assert.match(style, /\.purchase-date-strip\.is-compact \.week-day \{ flex:1 1 150px/);
  assert.match(style, /\.record-empty-context/);
});

test("balance action is a compact single-purpose payment control", async () => {
  const [app, homeView, style] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../home-rhythm-view.js", import.meta.url), "utf8"),
    readFile(new URL("../style.css", import.meta.url), "utf8")
  ]);
  assert.match(homeView, />Record payment<\/button>/);
  assert.match(homeView, /<b>Next action<\/b>/);
  assert.match(style, /\.balance-next button \{[^}]*white-space:nowrap/);
  assert.match(style, /\.balance-card \{ display:grid;/);
  assert.match(style, /\.balance-card \{ display:grid; grid-template-columns:minmax\(0,1fr\)/);
  assert.match(style, /\.rhythm-money \{ grid-template-areas:"balance" "actions"/);
  assert.match(style, /\.command-actions \{ grid-area:actions; display:grid; grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(style, /@media \(max-width:700px\)[\s\S]*\.command-actions \{ grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\);/);
  assert.match(style, /@media \(max-width:700px\)[\s\S]*\.command-actions \.settings-action \{ grid-column:1\/-1; width:auto; justify-self:center;/);
});

test("mobile masthead stacks the readable household title above compact members", async () => {
  const style = await readFile(new URL("../style.css", import.meta.url), "utf8");
  assert.match(style, /@media \(max-width:700px\)[\s\S]*\.household-masthead \{ flex-direction:column; align-items:stretch; gap:8px; \}/);
  assert.match(style, /\.household-title h1 \{ min-width:0; overflow-wrap:normal; word-break:normal; \}/);
  assert.match(style, /\.member-blocks \{ width:100%; justify-content:flex-start;/);
});
