import { en } from "./en";

// Only English for now. See "Widget i18n: French, Spanish and Italian".
const catalogs: Record<string, Record<string, string>> = { en };
let current = en;

export function setLocale(tag: string): void {
  current = catalogs[tag.slice(0, 2).toLowerCase()] ?? en;
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const template = current[key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}
