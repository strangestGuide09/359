import assert from "node:assert/strict";
import test from "node:test";
import { hasUnidentifiedAiItems, reconcileAiItemNames } from "../ai-item-names.js";

test("AI placeholders reuse local names only when row count and line totals align", () => {
  const ai = [{ name: "Unidentified receipt line 1", line_total: 80 }, { name: "Paneer", line_total: 145 }];
  const local = [{ name: "Akshayakalpa Set Cup Curd", line_total: 80 }, { name: "Akshayakalpa Malai Paneer", line_total: 145 }];
  assert.deepEqual(reconcileAiItemNames(ai, local).map(item => item.name), ["Akshayakalpa Set Cup Curd", "Paneer"]);
});

test("ambiguous AI rows keep their visible review warning instead of guessing", () => {
  const ai = [{ name: "Unidentified receipt line 1", line_total: 80 }];
  assert.equal(reconcileAiItemNames(ai, [{ name: "Curd", line_total: 81 }])[0].name, "Unidentified receipt line 1");
  assert.equal(reconcileAiItemNames(ai, [{ name: "Curd", line_total: 80 }, { name: "Paneer", line_total: 145 }])[0].name, "Unidentified receipt line 1");
  assert.equal(hasUnidentifiedAiItems(ai), true);
});
