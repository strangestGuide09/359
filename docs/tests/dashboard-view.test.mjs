import assert from "node:assert/strict";
import test from "node:test";
import { previewState } from "../dashboard-view.js";

test("restock preview has no unnecessary expansion at zero or four", () => {
  assert.deepEqual(previewState(0, 4), { expanded: false, hasToggle: false, visibleCount: 0, summary: "" });
  assert.deepEqual(previewState(4, 4), { expanded: false, hasToggle: false, visibleCount: 4, summary: "" });
});

test("restock preview shows four of a larger result and can expand in place", () => {
  assert.deepEqual(previewState(7, 4), { expanded: false, hasToggle: true, visibleCount: 4, summary: "Showing 4 of 7" });
  assert.deepEqual(previewState(7, 4, true), { expanded: true, hasToggle: true, visibleCount: 7, summary: "" });
});

test("settlement history uses its own compact latest-three preview", () => {
  assert.deepEqual(previewState(5, 3), { expanded: false, hasToggle: true, visibleCount: 3, summary: "Showing 3 of 5" });
});
