import { AUTOMATION_LIMITS } from "@template/contracts";
import { StepFailure } from "./errors";

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

/**
 * Only public HTTPS hosts; never the app's own origin or a private address. (The Worker also runs
 * with `global_fetch_strictly_public`, so a private address is refused at the network too.)
 */
export function allowedHttpUrl(raw: string, appOrigin: string): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `“${raw.slice(0, 80)}” isn't a web address.`;
  }
  if (url.protocol !== "https:") return "Only https:// addresses can be called.";
  if (url.username || url.password) return "Put credentials in a header, not in the address.";
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host)) return `${host} is a private address.`;
  try {
    if (host === new URL(appOrigin).hostname.toLowerCase())
      return "Automations can't call this app over HTTP; use an action step instead.";
  } catch {
    // An unset origin in tests.
  }
  return url;
}

/** A response body, at most `maxHttpResponseBytes`, parsed when it's JSON. */
export async function readBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > AUTOMATION_LIMITS.maxHttpResponseBytes) {
      await reader.cancel();
      throw new StepFailure(
        `The response was larger than ${AUTOMATION_LIMITS.maxHttpResponseBytes / 1000} KB.`,
        { retryable: false, hint: "Ask the service for a smaller response (filters, paging)." },
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if ((response.headers.get("content-type") ?? "").includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
