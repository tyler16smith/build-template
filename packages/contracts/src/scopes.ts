/**
 * OAuth scopes an MCP client (or a future native app) can be granted. Each module adds its own
 * read and write pair. Reading is always granted; writing is a checkbox on the consent screen.
 */
export const SCOPES = {
  "profile:read": "See your name, job title, email and company",
  "profile:write": "Change your name and job title",
  "organization:read": "See your company, its members and pending invitations",
  "organization:write": "Rename your company, invite people and change members' roles",
} as const;

export type Scope = keyof typeof SCOPES;

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/** Scopes granted to every connection, whatever the person ticks. */
export const ALWAYS_GRANTED: readonly Scope[] = ["profile:read", "organization:read"];

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && value in SCOPES;
}

/** The scopes a request may keep: known ones only, with the always-granted ones added. */
export function normalizeScopes(requested: readonly string[]): Scope[] {
  const known = requested.filter(isScope);
  return ALL_SCOPES.filter((s) => ALWAYS_GRANTED.includes(s) || known.includes(s));
}

export function isWriteScope(scope: Scope): boolean {
  return scope.endsWith(":write");
}
