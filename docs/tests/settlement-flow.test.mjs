import assert from "node:assert/strict";
import test from "node:test";
import { settlementAmountError, settlementConfirmation, settlementState } from "../settlement-flow.js";

test("negative balance offers the signed-in debtor a payment-sent action", () => {
  const state = settlementState(-114.5, "Ekta", "Ritesh");
  assert.deepEqual(state, {
    kind: "owes",
    amount: 114.5,
    actionLabel: "Record payment sent",
    guidance: "Ekta can record a payment to Ritesh."
  });
  assert.equal(settlementAmountError(-114.5, 114.5), "");
  assert.match(settlementAmountError(-114.5, 115), /no more than.*₹114\.50/);
});

test("positive balance directs the creditor to the partner without impersonating the payer", () => {
  const state = settlementState(114.5, "Ritesh", "Ekta");
  assert.equal(state.kind, "owed");
  assert.equal(state.actionLabel, null);
  assert.equal(state.guidance, "Ekta must sign in and record the payment to Ritesh.");
  assert.match(settlementAmountError(114.5, 114.5), /do not currently owe/);
});

test("zero balance exposes no settlement action", () => {
  assert.deepEqual(settlementState(0, "Ritesh", "Ekta"), {
    kind: "settled",
    amount: 0,
    actionLabel: null,
    guidance: "No settlement is needed."
  });
});

test("confirmation identifies direction, amount, and date", () => {
  assert.equal(settlementConfirmation("Ekta", "Ritesh", 114.5, "2026-07-21"), "Record this settlement?\n\nPayer: Ekta\nReceiver: Ritesh\nAmount: ₹114.50\nDate: 2026-07-21");
});
