export function canManageReceipt(purchase, userId, owner, householdActive) {
  return !!householdActive && !!purchase && (purchase.paid_by === userId || !!owner);
}

export function receiptEditChanges(purchase, values) {
  const changes = {
    label: values.label,
    category: values.category,
    paid_by: values.paidBy,
    purchased_on: values.purchasedOn
  };
  if (!(purchase.purchase_items || []).length) Object.assign(changes, {
    amount: values.amount,
    is_personal: values.personal,
    is_tracked_for_restock: false,
    estimated_use_by: null
  });
  return changes;
}
