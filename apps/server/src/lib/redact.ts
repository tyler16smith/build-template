/**
 * Redaction for everything the logger writes (ported from Custombase's `reliability/redact.ts`).
 * Keys that name credentials are dropped; in free text, bearer tokens, JWT-like and key-like
 * strings, email addresses, URL query strings and long numbers are replaced.
 */
export const MAX_LOG_TEXT = 2000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function redactLongNumber(match: string): string {
  const digits = match.replace(/\D/g, "").length;
  if (digits < 8 || ISO_DATE.test(match)) return match;
  return "[number]";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PATTERNS: [RegExp, string | ((match: string) => string)][] = [
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]"],
  [/(bearer\s+)[\w.~+/:-]+=*/gi, "$1[token]"],
  [/\b(sk|pk|rk|re|ghp|gho|xox[abp])[-_][\w-]{8,}/gi, "[token]"],
  [/ya29\.[\w.-]+/g, "[token]"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]"],
  [/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/gi, "$1?[query]"],
  [/(^|[\s"'(])(\/[^\s?#"']*)\?[^\s#"']*/g, "$1$2?[query]"],
  [/(__Host-[\w-]+=)[^;\s"']+/g, "$1[token]"],
  [/\+?\d[\d\s().-]{6,}\d/g, redactLongNumber],
  // Long opaque strings with letters and digits (session tokens, OAuth codes, keys). UUIDs stay:
  // request, user and organization ids are what the logs are for.
  [
    /\b(?=[\w+/-]*\d)(?=[\w+/-]*[A-Za-z])[\w+/-]{24,}={0,2}/g,
    (match: string) => (UUID.test(match) ? match : "[redacted]"),
  ],
];

const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function redactText(text: string, max = MAX_LOG_TEXT): string {
  // Request, user and organization ids are what the logs are for: set them aside so the number
  // and opaque-string patterns don't eat them, then put them back.
  const ids: string[] = [];
  let result = text.replace(UUID_IN_TEXT, (id) => `\u0000${ids.push(id) - 1}\u0000`);
  for (const [pattern, replacement] of PATTERNS)
    result = result.replace(pattern, replacement as (match: string) => string);
  result = result.replace(/\u0000(\d+)\u0000/g, (_, i: string) => ids[Number(i)] ?? "");
  return result.length > max ? `${result.slice(0, max)}…` : result;
}

/** Keys whose values are never logged, whatever they hold. */
export const SENSITIVE_KEY =
  /^(token|.*_token|.*Token|secret|.*Secret|password|.*Password|passwd|authorization|api[-_]?key|cookie|set-cookie|signature|credentials?|private[-_]?key|session|sessions|cookies|code|state|verifier|code_verifier|nonce|email|.*Email|name|title|input|output|body|handle)$/i;

/** A value as it may be logged: sensitive keys dropped, every string redacted. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested too deeply]";
  if (typeof value === "string") return redactText(value);
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, item]) => [key, redactValue(item, depth + 1)]),
    );
  return value;
}
