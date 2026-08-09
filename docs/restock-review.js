export function focusRestockReceipt(root, purchaseId) {
  const row = [...root.querySelectorAll("[data-purchase-id]")].find(candidate => candidate.dataset.purchaseId === purchaseId);
  if (!row) return false;
  row.classList.add("restock-review-target");
  row.tabIndex = -1;
  row.scrollIntoView?.({ behavior: "smooth", block: "center" });
  row.focus();
  row.addEventListener?.("blur", () => row.classList.remove("restock-review-target"), { once: true });
  return true;
}
