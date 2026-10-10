/** Ported from Custombase's `control-api/src/lib/crypto.ts`. WebCrypto only, so it runs in Workers. */
const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(encoder.encode(text));
}

export function base64UrlDecodeText(text: string): string {
  return new TextDecoder().decode(base64UrlDecode(text));
}

/** A random token, base64url: 32 bytes for sessions and email links. */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

export async function hmacSign(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(message),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export async function hmacVerify(
  secret: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlDecode(signature),
      encoder.encode(message),
    );
  } catch {
    return false;
  }
}

/**
 * What the database stores for a session or email token: `HMAC(token, SESSION_PEPPER)`. A leaked
 * database alone can't be turned into working cookies or links.
 */
export async function hashToken(token: string, pepper: string): Promise<string> {
  return hmacSign(pepper, token);
}

/**
 * PBKDF2-SHA256 iterations for new hashes. Workers' WebCrypto refuses more than 100,000, which
 * costs about 30 ms of CPU per hash on a Worker. The count is stored in each hash
 * (`pbkdf2$<iterations>$<salt>$<hash>`), so it can be raised later; `needsRehash` reports hashes
 * made with fewer, and sign-in rehashes them.
 */
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

/** A hash shaped like a real one, so an unknown email costs the same time as a wrong password. */
export const DUMMY_PASSWORD_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsText, saltText, hashText] = stored.split("$");
  const iterations = Number(iterationsText);
  if (scheme !== "pbkdf2" || !saltText || !hashText || !Number.isInteger(iterations)) return false;
  if (iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const expected = base64UrlDecode(hashText);
  const actual = await pbkdf2(password, base64UrlDecode(saltText), iterations);
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

export function needsRehash(stored: string): boolean {
  return Number(stored.split("$")[1]) < PBKDF2_ITERATIONS;
}
