import { ActionError, ERROR_STATUS, type ApiError, type ErrorCode } from "@template/contracts";
import { translateDatabaseError } from "@template/db";
import { ZodError } from "zod";

/** Codes that are an expected outcome (the person's input or rights), never a failure. */
const EXPECTED: ReadonlySet<ErrorCode> = new Set([
  "invalid_input",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "email_unverified",
  "confirmation_required",
  "not_a_member",
  "no_organization",
  "organization_changed",
]);

export function isExpected(code: ErrorCode): boolean {
  return EXPECTED.has(code);
}

/** A Zod failure as `invalid_input`, with a message per field. */
export function fromZod(error: ZodError): ActionError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  const first = error.issues[0]?.message ?? "Check what you entered.";
  return new ActionError("invalid_input", first, fields);
}

/**
 * Any thrown value as the error the person sees. `ActionError`s pass through, database errors
 * become their `ActionError`, and anything else becomes `internal` (logged with its fingerprint).
 */
export function toActionError(error: unknown): ActionError {
  if (error instanceof ActionError) return error;
  if (error instanceof ZodError) return fromZod(error);
  return translateDatabaseError(error);
}

export function errorBody(error: ActionError, requestId: string): { ok: false; error: ApiError } {
  return { ok: false, error: { ...error.toJSON(), requestId } };
}

export function errorResponse(
  error: ActionError,
  requestId: string,
  headers?: HeadersInit,
): Response {
  return Response.json(errorBody(error, requestId), {
    status: ERROR_STATUS[error.code],
    headers,
  });
}

/** The first stack frame in our code: `src/…` or `packages/…`, not `node_modules`. */
export function firstOwnFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n").slice(1)) {
    if (/node_modules|internal\/|<anonymous>/.test(line)) continue;
    const match =
      /(?:at\s+)?(?:(\S+)\s+\()?[^\s(]*?((?:src|packages|apps)\/[^\s:)]+)(?::\d+)?/.exec(line);
    if (match) return `${match[1] ?? ""}@${match[2]}`;
    const fn = /at\s+(\S+)/.exec(line)?.[1];
    if (fn) return fn;
  }
  return "";
}

/**
 * Groups errors: a hash of the error's name, the first stack frame in our code and the route or
 * action id. No ids or values, so the same bug has the same fingerprint every time.
 */
export async function fingerprint(error: unknown, where: string): Promise<string> {
  const name = error instanceof Error ? error.name : typeof error;
  const frame = error instanceof Error ? firstOwnFrame(error.stack) : "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${name}|${frame}|${where}`),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
