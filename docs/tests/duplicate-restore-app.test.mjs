import assert from "node:assert/strict";
import test from "node:test";
import { restorableDuplicatePurchaseId } from "../invoice-duplicate.js";
import { duplicateRestoreAction } from "../duplicate-restore-action.js";

function statefulDuplicateClient({ authorized = true } = {}) {
  const receipt = { id: "archived-receipt", archived: true };
  return {
    receipt,
    async find() {
      return authorized
        ? { duplicate_status: "linked_archived_restorable", purchase_id: receipt.id, can_restore: true }
        : { duplicate_status: "linked_archived_not_authorized", purchase_id: null, can_restore: false };
    },
    async restore(id) {
      assert.equal(id, receipt.id);
      receipt.archived = false;
      return true;
    }
  };
}

test("archived exact duplicate offers restore and clicking restores without creating a duplicate", async () => {
  const client = statefulDuplicateClient();
  const result = await client.find();
  let safeSuccess = "";
  const action = duplicateRestoreAction({
    restoreId: restorableDuplicatePurchaseId(result),
    existingLabel: "Instamart",
    restore: async id => { const restored = await client.restore(id); if (restored) safeSuccess = "Removed receipt restored. No duplicate was created."; return restored; }
  });
  assert.equal(action.label, "Restore removed receipt");
  assert.match(action.ariaLabel, /Instamart/);
  const button = { disabled: false };
  await action.onClick({ currentTarget: button });
  assert.equal(client.receipt.archived, false);
  assert.equal(button.disabled, true);
  assert.equal(safeSuccess, "Removed receipt restored. No duplicate was created.");
});

test("partner without restore authority is never offered the shortcut", async () => {
  const client = statefulDuplicateClient({ authorized: false });
  const result = await client.find();
  assert.equal(restorableDuplicatePurchaseId(result), null);
  assert.equal(duplicateRestoreAction({ restoreId: restorableDuplicatePurchaseId(result), restore: id => client.restore(id) }), undefined);
  assert.equal(client.receipt.archived, true);
});
