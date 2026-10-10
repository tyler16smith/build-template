import { base64UrlDecode, base64UrlEncode } from "@template/auth";
import { ActionError } from "@template/contracts";

/**
 * Secrets that must be read back (a Zapier Catch Hook URL, a webhook's signing secret) are sealed
 * with AES-GCM under `CONNECTION_ENCRYPTION_KEY`. The additional data names what the value
 * belongs to (`zapier:<organization>:<connection>`), so a sealed value copied onto another row
 * doesn't open. Format: `v1.<iv>.<ciphertext>`, base64url.
 */
const VERSION = "v1";

async function key(raw: string | undefined): Promise<CryptoKey> {
  if (!raw)
    throw new ActionError(
      "conflict",
      "Connections aren't set up on this deployment yet (CONNECTION_ENCRYPTION_KEY is missing).",
    );
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("CONNECTION_ENCRYPTION_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(
  secret: string | undefined,
  context: string,
  value: unknown,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
}

export async function open<T>(
  secret: string | undefined,
  context: string,
  sealed: string,
): Promise<T> {
  const [version, iv, cipher] = sealed.split(".");
  if (version !== VERSION || !iv || !cipher) throw new Error("Not a sealed value");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(iv), additionalData: new TextEncoder().encode(context) },
    await key(secret),
    base64UrlDecode(cipher),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
