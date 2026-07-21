const EPSILON = 0.005;

export function settlementState(balance, currentName, partnerName) {
  const value = Number(balance) || 0;
  if (Math.abs(value) < EPSILON) return { kind: "settled", amount: 0, actionLabel: null, guidance: "No settlement is needed." };
  if (value < 0) {
    const amount = -value;
    return {
      kind: "owes",
      amount,
      actionLabel: "Record payment sent",
      guidance: `${currentName} can record a payment to ${partnerName}.`
    };
  }
  return {
    kind: "owed",
    amount: value,
    actionLabel: null,
    guidance: `${partnerName} must sign in and record the payment to ${currentName}.`
  };
}

export function settlementAmountError(balance, amount) {
  const outstanding = Math.max(0, -(Number(balance) || 0));
  const payment = Number(amount);
  if (!Number.isFinite(payment) || payment <= 0) return "Enter an amount above zero.";
  if (outstanding < EPSILON) return "You do not currently owe a balance, so no payment can be recorded.";
  if (payment - outstanding > EPSILON) return `Enter no more than the outstanding balance of ₹${outstanding.toFixed(2)}.`;
  return "";
}

export function settlementConfirmation(payerName, receiverName, amount, date) {
  return `Record this settlement?\n\nPayer: ${payerName}\nReceiver: ${receiverName}\nAmount: ₹${Number(amount).toFixed(2)}\nDate: ${date}`;
}
