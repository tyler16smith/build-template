/** The product's name, as screens show it. `pnpm rename` rewrites it. */
export const APP_NAME = "Build Template";

/**
 * What screens call an organization. Code and routes say "organization"; a product says
 * "company", "workspace" or "shop" here, without touching a screen.
 */
export const ORGANIZATION_NOUN = { one: "company", many: "companies" } as const;

/** `ORGANIZATION_NOUN.one` with a capital: "Company". */
export function organizationLabel(plural = false): string {
  const word = plural ? ORGANIZATION_NOUN.many : ORGANIZATION_NOUN.one;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** "BB" for Bea Brickley, "TP" for Three Pigs Construction. */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}
