export function importReviewedPurchase(client, values) {
  return client.rpc("import_reviewed_purchase", values);
}

export function updateReviewedPurchase(client, values) {
  return client.rpc("update_reviewed_purchase", values);
}

export function loadReviewedPurchases(client, householdId, archived = false) {
  const request = client.from("purchases").select("*,purchase_items(*)").eq("household_id", householdId);
  return archived ? request.not("archived_at", "is", null) : request.is("archived_at", null);
}
