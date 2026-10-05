import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";

const catalogs: Record<string, Record<string, string>> = { en, es, fr, it };
let current = en;

/** Pick the catalog for a BCP 47 tag such as "es-ES" or "fr", falling back to English. */
export function setLocale(tag: string): void {
  current = catalogs[tag.slice(0, 2).toLowerCase()] ?? en;
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const template = current[key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}
