export function duplicateState(result) {
  return result?.duplicate_status || result?.state || "ambiguous";
}

export function duplicateMatchBasis(result) {
  return ["exact", "exact_and_content", "content"].includes(result?.match_basis)
    ? result.match_basis
    : "unknown";
}

export function isExactDuplicate(result) {
  return ["exact", "exact_and_content"].includes(duplicateMatchBasis(result));
}

export function restorableDuplicatePurchaseId(result) {
  return duplicateState(result) === "linked_archived_restorable" && result?.can_restore === true && result?.purchase_id
    ? result.purchase_id
    : null;
}
