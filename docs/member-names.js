export function formatMemberName(value) {
  const name = String(value ?? "").trim();
  if (!name || name !== name.toLocaleLowerCase() || name === name.toLocaleUpperCase()) return name;
  return name.replace(/(^|[\s'-])(\p{Ll})/gu, (_, boundary, letter) => `${boundary}${letter.toLocaleUpperCase()}`);
}
