export function withItemSumReviewAmount(parsed) {
  if (!parsed || String(parsed.defaults?.amount || "").trim()) return parsed;
  if (/do not reconcile|structurally unreliable/i.test(String(parsed.parserWarning || ""))) return parsed;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const totals = items.map(item => item?.line_total == null || item.line_total === "" ? NaN : Number(item.line_total));
  if (!totals.length || totals.some(total => !Number.isFinite(total) || total < 0)) return parsed;
  const sum = totals.reduce((total, value) => total + value, 0);
  if (sum <= 0) return parsed;
  const warning = "Calculated from item totals — verify against the receipt before saving.";
  return {
    ...parsed,
    defaults: { ...parsed.defaults, amount: sum.toFixed(2) },
    parserWarning: warning,
    totalConfidence: "item-sum",
    amountSource: "item-sum"
  };
}
