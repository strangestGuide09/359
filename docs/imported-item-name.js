/** Remove invoice classification codes without changing product quantities or pack text. */
export function cleanImportedItemName(value) {
  return String(value ?? "")
    .replace(/\(\s*hsn\s*[-:#]?\s*\d(?:[\d-]{2,10}\d)?\s*\)/gi, " ")
    .replace(/\bhsn\s*[-:#]?\s*\d(?:[\d-]{2,10}\d)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/\s*[-–—|,:;]\s*$/, "")
    .trim();
}
