import { ActionError } from "@template/contracts";
import type { GoogleClaims } from "./accounts";
import { base64UrlDecode, base64UrlDecodeText, base64UrlEncode, randomToken } from "./crypto";

/**
 * Continue with Google (OpenID Connect, authorization code flow with PKCE). Off until
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set; the server checks that.
 */
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** What `/auth/google/start` keeps in the signed `__Host-google` cookie until the callback. */
export type GoogleFlow = { state: string; verifier: string; nonce: string; returnTo: string };

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function startGoogleFlow(
  config: GoogleConfig,
  returnTo: string,
): Promise<{ flow: GoogleFlow; url: string }> {
  const flow: GoogleFlow = {
    state: randomToken(24),
    verifier: randomToken(48),
    nonce: randomToken(24),
    returnTo,
  };
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await pkceChallenge(flow.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { flow, url: url.toString() };
}

const failed = () => new ActionError("unauthenticated", "Google sign-in didn't finish. Try again.");

/** Exchanges the callback's code for an ID token. */
export async function exchangeGoogleCode(
  config: GoogleConfig,
  code: string,
  verifier: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const response = await fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw failed();
  const body = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  if (typeof body?.id_token !== "string") throw failed();
  return body.id_token;
}

type Jwk = JsonWebKey & { kid?: string };
let jwks: { keys: Jwk[]; expiresAt: number } | null = null;

/** Google's signing keys, cached per isolate for as long as Google's `max-age` says. */
async function googleKeys(fetcher: Fetcher, now: number, refresh = false): Promise<Jwk[]> {
  if (jwks && !refresh && jwks.expiresAt > now) return jwks.keys;
  const response = await fetcher(GOOGLE_JWKS_URL);
  if (!response.ok) throw failed();
  const body = (await response.json()) as { keys?: Jwk[] };
  const maxAge = Number(
    /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1] ?? 3600,
  );
  jwks = { keys: body.keys ?? [], expiresAt: now + Math.min(maxAge, 86_400) * 1000 };
  return jwks.keys;
}

export function resetGoogleKeyCache(): void {
  jwks = null;
}

/**
 * Verifies an ID token: RS256 signature against Google's keys, then `iss`, `aud`, `exp` and the
 * `nonce` this flow sent.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<GoogleClaims> {
  const [headerText, payloadText, signatureText] = idToken.split(".");
  if (!headerText || !payloadText || !signatureText) throw failed();
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecodeText(headerText));
    payload = JSON.parse(base64UrlDecodeText(payloadText));
  } catch {
    throw failed();
  }
  if (header.alg !== "RS256" || !header.kid) throw failed();
  let jwk = (await googleKeys(fetcher, now)).find((k) => k.kid === header.kid);
  // Google rotates keys; a kid we haven't seen means our copy is old.
  if (!jwk) jwk = (await googleKeys(fetcher, now, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw failed();
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signatureText),
    new TextEncoder().encode(`${headerText}.${payloadText}`),
  );
  if (!valid) throw failed();
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (
    !ISSUERS.includes(String(payload.iss)) ||
    !audiences.includes(expected.clientId) ||
    typeof payload.exp !== "number" ||
    payload.exp * 1000 < now - 60_000 ||
    payload.nonce !== expected.nonce ||
    typeof payload.sub !== "string" ||
    typeof payload.email !== "string"
  )
    throw failed();
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" ? payload.name : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}

/**
 * A same-origin path to come back to after sign-in (the OAuth consent screen, say). Anything
 * else — another origin, `//host`, a backslash trick — becomes `/`.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !/^\/(?![/\\])/.test(value) || /[\r\n]/.test(value)) return "/";
  return value.slice(0, 2000);
}
