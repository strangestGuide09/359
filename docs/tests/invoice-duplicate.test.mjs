import assert from "node:assert/strict";
import test from "node:test";
import { duplicateState, restorableDuplicatePurchaseId } from "../invoice-duplicate.js";

const id = "11111111-1111-4111-8111-111111111111";

test("only the deterministic authorized archived state exposes a restore target", () => {
  assert.equal(restorableDuplicatePurchaseId({ duplicate_status: "linked_archived_restorable", purchase_id: id, can_restore: true }), id);
  for (const duplicate_status of ["none", "linked_active", "linked_archived_not_authorized", "legacy_unlinked", "ambiguous"]) {
    assert.equal(restorableDuplicatePurchaseId({ duplicate_status, purchase_id: id, can_restore: true }), null, duplicate_status);
  }
  assert.equal(restorableDuplicatePurchaseId({ duplicate_status: "linked_archived_restorable", purchase_id: id, can_restore: false }), null);
  assert.equal(restorableDuplicatePurchaseId({ duplicate_status: "linked_archived_restorable", can_restore: true }), null);
});

test("missing duplicate results fail closed as ambiguous", () => {
  assert.equal(duplicateState(null), "ambiguous");
  assert.equal(duplicateState({}), "ambiguous");
  assert.equal(duplicateState({ state: "legacy_unlinked" }), "legacy_unlinked");
});
