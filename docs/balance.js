const cents = value => Math.round((Number(value) || 0) * 100);

/** Settlements may reduce the current shared-expense balance, never create or enlarge one. */
export function settledExpenseBalance(expenseBalance, settlementBalance) {
  const expense = cents(expenseBalance);
  if (!expense) return 0;
  const combined = expense + cents(settlementBalance);
  if (expense > 0) return Math.min(expense, Math.max(0, combined)) / 100;
  return Math.max(expense, Math.min(0, combined)) / 100;
}

/** Replay active shared expenses and settlement history without carrying unused payments forward. */
export function chronologicalBalance(expenses, settlements) {
  const events = [
    ...expenses.map(expense => ({ date: String(expense.date || ""), kind: "expense", cents: cents(expense.amount) })),
    ...settlements.map(settlement => ({ date: String(settlement.date || ""), kind: "settlement", cents: cents(settlement.amount) }))
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "expense" ? -1 : 1));
  let outstanding = 0;
  for (const event of events) {
    if (event.kind === "expense") {
      outstanding += event.cents;
      continue;
    }
    if (outstanding > 0 && event.cents < 0) outstanding = Math.max(0, outstanding + event.cents);
    else if (outstanding < 0 && event.cents > 0) outstanding = Math.min(0, outstanding + event.cents);
  }
  return outstanding / 100;
}
