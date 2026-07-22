import assert from "node:assert/strict";
import test from "node:test";
import { applyPresentation, PRESENTATION_KEY, readPresentation, savePresentation } from "../appearance.js";

const fakeDocument = () => {
  const inputs = [{ value: "classic", checked: false }, { value: "sketch", checked: false }];
  return { documentElement: { dataset: {} }, querySelectorAll: () => inputs, inputs };
};

test("classic is the safe default for missing or invalid preferences", () => {
  assert.equal(readPresentation({ getItem: () => null }), "classic");
  assert.equal(readPresentation({ getItem: () => "unknown" }), "classic");
  assert.equal(readPresentation({ getItem: () => { throw new Error("blocked"); } }), "classic");
});

test("sketch choice persists locally and restores the native control state", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(savePresentation(storage, "sketch"), "sketch");
  assert.equal(values.get(PRESENTATION_KEY), "sketch");
  const document = fakeDocument();
  assert.equal(applyPresentation(document, readPresentation(storage)), "sketch");
  assert.equal(document.documentElement.dataset.presentation, "sketch");
  assert.deepEqual(document.inputs.map(input => input.checked), [false, true]);
});

test("switching presentation changes only the root attribute and checked radio", () => {
  const document = fakeDocument();
  applyPresentation(document, "classic");
  const rootKeys = Object.keys(document.documentElement.dataset);
  applyPresentation(document, "sketch");
  assert.deepEqual(rootKeys, ["presentation"]);
  assert.deepEqual(Object.keys(document.documentElement.dataset), ["presentation"]);
  assert.deepEqual(document.inputs.map(input => input.checked), [false, true]);
});
