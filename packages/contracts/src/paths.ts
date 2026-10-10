/** Paths the Worker serves (everything else is the single-page app). */
export const PATHS = {
  mcp: "/mcp",
  authorize: "/authorize",
  token: "/token",
  register: "/register",
  consent: "/oauth/consent",
  googleStart: "/auth/google/start",
  googleCallback: "/auth/google/callback",
} as const;

/** The session cookie. `__Host-` pins it to this origin, `Secure` and `Path=/`. */
export const SESSION_COOKIE = "__Host-session";

/**
 * The organization the web app's current page was loaded for, sent with every call. It can only
 * cause a refusal (`organization_changed`); it never selects an organization.
 */
export const ORGANIZATION_HEADER = "x-organization-id";
