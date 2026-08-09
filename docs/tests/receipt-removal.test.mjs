import assert from "node:assert/strict";
import test from "node:test";
import { forgetRemovedReceipt, readRemovedReceipt, RECEIPT_UNDO_KEY, rememberRemovedReceipt } from "../receipt-removal.js";

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test("an exact removed receipt survives a page render in the same session", () => {
  const session = storage();
  const receipt = { id: "receipt-1", label: "Instamart", archived_at: "2026-08-09T12:00:00Z" };
  rememberRemovedReceipt(session, "household-1", "user-1", receipt.id);
  assert.equal(readRemovedReceipt(session, "household-1", "user-1", [receipt]), receipt);
  assert.deepEqual(JSON.parse(session.getItem(RECEIPT_UNDO_KEY)), { householdId: "household-1", userId: "user-1", purchaseId: "receipt-1" });
});

test("undo state fails closed across users, households, and completed restores", () => {
  const session = storage();
  rememberRemovedReceipt(session, "household-1", "user-1", "receipt-1");
  assert.equal(readRemovedReceipt(session, "household-2", "user-1", [{ id: "receipt-1" }]), null);
  assert.equal(readRemovedReceipt(session, "household-1", "user-2", [{ id: "receipt-1" }]), null);
  assert.equal(readRemovedReceipt(session, "household-1", "user-1", []), null);
  assert.equal(session.getItem(RECEIPT_UNDO_KEY), null);
});

test("successful restore clears only the matching pending undo", () => {
  const session = storage();
  rememberRemovedReceipt(session, "household-1", "user-1", "receipt-1");
  forgetRemovedReceipt(session, "receipt-2");
  assert.notEqual(session.getItem(RECEIPT_UNDO_KEY), null);
  forgetRemovedReceipt(session, "receipt-1");
  assert.equal(session.getItem(RECEIPT_UNDO_KEY), null);
});
