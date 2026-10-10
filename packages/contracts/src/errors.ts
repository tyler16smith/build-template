/**
 * Every failure the API, the MCP tools and the clients share. Messages are written for the
 * person: the web app and MCP tool results show them as they are.
 */
export const ERROR_CODES = [
  "invalid_input",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "email_unverified",
  /**
   * A write too large to run without the person's say-so (a bulk delete, say). Agents ask the
   * person, then call again with `ctx.confirmed` set (`specs/ai.md`, "Confirmation").
   */
  "confirmation_required",
  /** The person isn't (or is no longer) a member of the organization the request is for. */
  "not_a_member",
  /** The person hasn't joined or created a company yet: the web app sends them to `/onboarding`. */
  "no_organization",
  /**
   * The page was loaded for another organization than the session has open (another tab
   * switched). Nothing ran; the web app reloads into the open one (`X-Organization-Id`).
   */
  "organization_changed",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ApiError = {
  code: ErrorCode;
  message: string;
  /** Per-field messages for `invalid_input`, keyed by the input's field name. */
  fields?: Record<string, string>;
  /** The request's id: quote it to find the request in the logs. */
  requestId?: string;
};

/** The HTTP status each code is sent with. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  email_unverified: 403,
  confirmation_required: 409,
  not_a_member: 403,
  no_organization: 403,
  organization_changed: 409,
  internal: 500,
};

export class ActionError extends Error {
  override name = "ActionError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }

  toJSON(): ApiError {
    return {
      code: this.code,
      message: this.message,
      ...(this.fields ? { fields: this.fields } : {}),
    };
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
