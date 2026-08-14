export function duplicateRestoreAction({ restoreId, existingLabel, restore }) {
  if (!restoreId) return undefined;
  return {
    label: "Restore removed receipt",
    ariaLabel: `Restore ${existingLabel || "removed receipt"} to the ledger`,
    onClick: async event => {
      const button = event.currentTarget;
      button.disabled = true;
      if (!await restore(restoreId)) button.disabled = false;
    }
  };
}
