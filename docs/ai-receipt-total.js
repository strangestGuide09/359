const paise = value => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
};

export function resolveAiReceiptTotal(localAmount, aiAmount, aiItems = []) {
  const localPaise = paise(localAmount);
  const aiPaise = paise(aiAmount);
  const itemPaise = Array.isArray(aiItems)
    ? Math.round(aiItems.reduce((sum, item) => sum + (Number(item?.line_total) || 0), 0) * 100)
    : 0;

  if (localPaise == null) return { amount: aiPaise == null ? "" : (aiPaise / 100).toFixed(2), warning: "" };

  const differsFromAiAmount = aiPaise != null && aiPaise !== localPaise;
  const differsFromAiItems = itemPaise > 0 && itemPaise !== localPaise;
  const warning = differsFromAiAmount || differsFromAiItems
    ? "The AI item totals differ from the locally identified receipt total. The local receipt total was kept; review the AI line items before saving."
    : "";
  return { amount: (localPaise / 100).toFixed(2), warning };
}
