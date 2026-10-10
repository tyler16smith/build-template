import { ActionError } from "@template/contracts";

/** SQLSTATE classes we name. Messages are never kept: they can quote values and columns. */
const CLASSES: Record<string, string> = {
  "23505": "unique_violation",
  "23503": "foreign_key_violation",
  "23502": "not_null_violation",
  "23514": "check_violation",
  "22P02": "invalid_text",
  "22001": "value_too_long",
  "22003": "out_of_range",
  "22007": "invalid_datetime",
  "22008": "invalid_datetime",
  "42501": "insufficient_privilege",
  "57014": "timeout",
  "40001": "serialization_failure",
  "40P01": "deadlock",
  "53300": "too_many_connections",
  "08000": "connection",
  "08003": "connection",
  "08006": "connection",
  "57P01": "connection",
};

/** The SQLSTATE of a driver error, looking through Drizzle's `DrizzleQueryError` wrapper. */
export function sqlState(error: unknown): string | null {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current !== "object") return null;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The constraint a unique or foreign-key violation names, if the driver reported it. */
export function violatedConstraint(error: unknown): string | null {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current !== "object") return null;
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function errorClass(error: unknown): string {
  const state = sqlState(error);
  if (state && CLASSES[state]) return CLASSES[state]!;
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  if (/row-level security/i.test(message)) return "insufficient_privilege";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/connect|ECONNRE|socket|terminated|fetch failed/i.test(message)) return "connection";
  return "database_error";
}

/**
 * A database failure as an `ActionError` the person can read. `ActionError`s pass through.
 * Anything unexpected becomes `internal`, with no detail that could leak a value.
 */
export function translateDatabaseError(error: unknown): ActionError {
  if (error instanceof ActionError) return error;
  switch (errorClass(error)) {
    case "unique_violation":
      return new ActionError("conflict", "Something with those details already exists.");
    case "foreign_key_violation":
      return new ActionError("invalid_input", "That refers to something that doesn't exist.");
    case "not_null_violation":
      return new ActionError("invalid_input", "A required value is missing.");
    case "check_violation":
    case "invalid_text":
    case "value_too_long":
    case "out_of_range":
    case "invalid_datetime":
      return new ActionError("invalid_input", "A value is outside what this field allows.");
    case "insufficient_privilege":
      return new ActionError("forbidden", "That belongs to another organization.");
    case "timeout":
    case "serialization_failure":
    case "deadlock":
    case "too_many_connections":
    case "connection":
      return new ActionError("rate_limited", "We're busy right now. Try again in a moment.");
    default:
      return new ActionError("internal", "Something went wrong on our side. Try again.");
  }
}
