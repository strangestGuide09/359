export const PRESENTATION_KEY = "grocery-ledger-presentation";

export function normalizePresentation(value) {
  return value === "sketch" ? "sketch" : "classic";
}

export function readPresentation(storage) {
  try { return normalizePresentation(storage?.getItem(PRESENTATION_KEY)); }
  catch { return "classic"; }
}

export function applyPresentation(document, value) {
  const presentation = normalizePresentation(value);
  document.documentElement.dataset.presentation = presentation;
  document.querySelectorAll('input[name="presentation"]').forEach(input => { input.checked = input.value === presentation; });
  return presentation;
}

export function savePresentation(storage, value) {
  const presentation = normalizePresentation(value);
  try { storage?.setItem(PRESENTATION_KEY, presentation); } catch {}
  return presentation;
}
