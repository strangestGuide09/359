import assert from "node:assert/strict";
import test from "node:test";
import { formatMemberName } from "../member-names.js";

test("fully lowercase member names receive display-only capitalization", () => {
  assert.equal(formatMemberName("ekta"), "Ekta");
  assert.equal(formatMemberName("ritesh kumar"), "Ritesh Kumar");
});

test("mixed and intentional casing is preserved verbatim", () => {
  assert.equal(formatMemberName("eKta"), "eKta");
  assert.equal(formatMemberName("Ritesh McDonald"), "Ritesh McDonald");
  assert.equal(formatMemberName("EKTA"), "EKTA");
});
