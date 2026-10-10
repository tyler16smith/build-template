import { SESSION_COOKIE } from "@template/contracts";
import { base64UrlDecodeText, base64UrlEncodeText, hmacSign, hmacVerify } from "./crypto";

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** `__Host-session`: Secure, HttpOnly, SameSite=Lax, Path=/. Null clears it. */
export function sessionCookie(token: string | null, maxAgeMs = 0): string {
  const base = `${SESSION_COOKIE}=${token ?? ""}; Path=/; Secure; HttpOnly; SameSite=Lax`;
  return token ? `${base}; Max-Age=${Math.floor(maxAgeMs / 1000)}` : `${base}; Max-Age=0`;
}

/**
 * A short-lived signed cookie (`__Host-google` during Google sign-in). The value is the JSON
 * payload and an HMAC of it; tampering, or a cookie past `expiresAt`, reads as null.
 */
export async function signedCookie(
  name: string,
  payload: Record<string, unknown>,
  secret: string,
  maxAgeSeconds: number,
): Promise<string> {
  const body = base64UrlEncodeText(
    JSON.stringify({ ...payload, expiresAt: Date.now() + maxAgeSeconds * 1000 }),
  );
  const signature = await hmacSign(secret, `${name}.${body}`);
  return `${name}=${body}.${signature}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export async function readSignedCookie<T extends Record<string, unknown>>(
  header: string | null,
  name: string,
  secret: string,
): Promise<T | null> {
  const value = readCookie(header, name);
  if (!value) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature || !(await hmacVerify(secret, `${name}.${body}`, signature))) return null;
  try {
    const payload = JSON.parse(base64UrlDecodeText(body)) as T & { expiresAt?: number };
    if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
