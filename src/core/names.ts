/** Name normalization shared by the generator and the runtime. */

const ACRONYM_FIXES: Array<[RegExp, string]> = [
  [/DDoS/g, 'Ddos'],
  [/IdP/g, 'Idp'],
  [/IDs\b/g, 'Ids'],
  [/E2E/g, 'E2e'],
  [/C2pa/g, 'C2pa'],
];

/** camelCase / PascalCase / snake_case → kebab-case. */
export function kebab(s: string): string {
  let v = s;
  for (const [re, rep] of ACRONYM_FIXES) v = v.replace(re, rep);
  return v
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z]{2,})/g, '$1-$2')
    .replace(/([0-9])([A-Z][a-z])/g, '$1-$2')
    .replace(/_/g, '-')
    .replace(/--+/g, '-')
    .toLowerCase();
}

/** Loose key used for matching user input against names: lower-case, no separators. */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[-_\s.]/g, '');
}

/** snake_case → kebab-case for flags (`per_page` → `per-page`). */
export function flagName(s: string): string {
  return s.replace(/_/g, '-');
}
