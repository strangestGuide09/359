import assert from "node:assert/strict";
import test from "node:test";
import { chronologicalBalance, settledExpenseBalance } from "../balance.js";

test("settlement history cannot create debt when no active shared amount remains", () => {
  assert.equal(settledExpenseBalance(0, 470.50), 0);
  assert.equal(settledExpenseBalance(0, -470.50), 0);
});

test("personal-only active receipts remain a zero balance despite payment history", () => {
  const personalOnlyExpenseBalance = 0;
  assert.equal(settledExpenseBalance(personalOnlyExpenseBalance, 120), 0);
});

test("over-settlement after partial receipt removal clamps at zero", () => {
  assert.equal(settledExpenseBalance(-100, 470.50), 0);
  assert.equal(settledExpenseBalance(100, -470.50), 0);
});

test("normal settlements reduce but never enlarge the expense-derived balance", () => {
  assert.equal(settledExpenseBalance(-470.50, 200), -270.50);
  assert.equal(settledExpenseBalance(470.50, -200), 270.50);
  assert.equal(settledExpenseBalance(-100, -25), -100);
  assert.equal(settledExpenseBalance(100, 25), 100);
});

test("currency rounding is stable at the accounting boundary", () => {
  assert.equal(settledExpenseBalance(114.505, -14.504), 100.01);
  assert.equal(settledExpenseBalance(-0.004, 10), 0);
});

test("an old unused settlement cannot offset a later active expense", () => {
  const oldSettlement = [{ date: "2026-07-01", amount: 470.50 }];
  assert.equal(chronologicalBalance([], oldSettlement), 0);
  assert.equal(chronologicalBalance([{ date: "2026-08-01", amount: -100 }], oldSettlement), -100);
});

test("settlements apply only to the balance outstanding on their date", () => {
  const expenses = [
    { date: "2026-07-01", amount: -100 },
    { date: "2026-08-01", amount: -80 }
  ];
  assert.equal(chronologicalBalance(expenses, [{ date: "2026-07-15", amount: 150 }]), -80, "the unused ₹50 does not carry forward");
  assert.equal(chronologicalBalance(expenses, [{ date: "2026-08-02", amount: 150 }]), -30, "a later payment can offset both outstanding expenses");
});

test("same-day expenses are available before their settlement", () => {
  assert.equal(chronologicalBalance([{ date: "2026-08-01", amount: 100 }], [{ date: "2026-08-01", amount: -40 }]), 60);
});
