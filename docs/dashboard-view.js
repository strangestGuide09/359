export function previewState(total, limit, expanded = false) {
  const count = Math.max(0, Number(total) || 0);
  const cap = Math.max(1, Number(limit) || 1);
  const hasToggle = count > cap;
  return {
    expanded: hasToggle && expanded,
    hasToggle,
    visibleCount: hasToggle && !expanded ? cap : count,
    summary: hasToggle && !expanded ? `Showing ${cap} of ${count}` : ""
  };
}
