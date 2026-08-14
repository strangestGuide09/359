export function isMissingReviewedImportSignature(error) {
  if (!error) return false;
  const code = String(error.code || "").toUpperCase();
  const message = String(error.message || error.details || "").toLowerCase();
  return ["PGRST202", "42883"].includes(code)
    && message.includes("import_reviewed_purchase")
    && /schema cache|could not find|does not exist|function/.test(message);
}

export async function importReviewedPurchase(client, values) {
  const current = await client.rpc("import_reviewed_purchase", values);
  if (!isMissingReviewedImportSignature(current.error)) return current;

  const legacy = { ...values };
  delete legacy.p_content_hash_reliable;
  if (values.p_content_hash_reliable === false) legacy.p_content_hash = values.p_exact_pdf_hash;
  const retried = await client.rpc("import_reviewed_purchase", legacy);
  if (!retried.error) return retried;
  return {
    ...retried,
    error: {
      ...retried.error,
      code: retried.error.code || current.error.code,
      message: "This database must be upgraded before this reviewed receipt can be saved. Your draft is still here; ask the household owner to apply the latest database migration, then retry."
    }
  };
}

export function updateReviewedPurchase(client, values) {
  return client.rpc("update_reviewed_purchase", values);
}

export function loadReviewedPurchases(client, householdId, archived = false) {
  const request = client.from("purchases").select("*,purchase_items(*)").eq("household_id", householdId);
  return archived ? request.not("archived_at", "is", null) : request.is("archived_at", null);
}
