import { AUTOMATION_LIMITS } from "@template/contracts";

const SENSITIVE_KEY =
  /(token|secret|password|passwd|authorization|api[-_]?key|cookie|signature|credential|private[-_]?key)/i;
const MAX_STRING = 2000;

function scrub(value: unknown, depth: number): unknown {
  if (depth > 8) return "[nested too deeply]";
  if (typeof value === "string")
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}… (${value.length - MAX_STRING} more characters)`
      : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : scrub(item, depth + 1),
      ]),
    );
  }
  return value;
}

/**
 * The copy of a step's input or output that is stored for run history and shown to people:
 * credential-like fields removed, long text shortened, and the whole value size-capped.
 */
export function redact(value: unknown): unknown {
  if (value === undefined) return null;
  const scrubbed = scrub(value, 0);
  const text = JSON.stringify(scrubbed) ?? "null";
  if (text.length <= AUTOMATION_LIMITS.maxStoredValueBytes) return scrubbed;
  return { truncated: true, preview: text.slice(0, MAX_STRING) };
}

/** Error text for people and logs, with anything that looks like a bearer token removed. */
export function redactMessage(message: string): string {
  return message
    .replace(/(bearer\s+)[\w.~+/-]+=*/gi, "$1[redacted]")
    .replace(/ya29\.[\w.-]+/g, "[redacted]")
    .slice(0, 2000);
}
