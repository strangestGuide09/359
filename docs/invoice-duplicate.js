export function duplicateState(result) {
  return result?.duplicate_status || result?.state || "ambiguous";
}

export function restorableDuplicatePurchaseId(result) {
  return duplicateState(result) === "linked_archived_restorable" && result?.can_restore === true && result?.purchase_id
    ? result.purchase_id
    : null;
}
