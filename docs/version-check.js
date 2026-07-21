export function hasUnsafeDraft({ dialogOpen, pendingPdfImport, formDirty }) {
  return !!(dialogOpen || pendingPdfImport || formDirty);
}

export function versionAction(currentBuild, nextBuild, unsafeDraft, reloadAttemptedFor) {
  if (!nextBuild || nextBuild === currentBuild) return "none";
  if (unsafeDraft || reloadAttemptedFor === nextBuild) return "prompt";
  return "reload";
}
