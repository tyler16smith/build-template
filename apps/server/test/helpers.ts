import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import type { CapturedMail } from "@template/contracts";
import type { Env } from "../src/env";
import worker from "../src/index";

export const env = workerEnv as unknown as Env;
export const ORIGIN = "https://app.test";

/** Calls the Worker's own `fetch`, as the runtime would. */
export async function call(request: Request): Promise<Response> {
  const exec = createExecutionContext();
  const response = await worker.fetch(request, env, exec);
  await waitOnExecutionContext(exec);
  return response;
}

/** Empties every table (the SQL proxy truncates as the owner). */
export async function resetDatabase(): Promise<void> {
  await env.TEST_SQL!.fetch("http://sql/reset", { method: "POST", body: "{}" });
}

/** A browser on the app's origin: keeps cookies, sends `Origin` on writes. */
export class Browser {
  readonly cookies = new Map<string, string>();

  async fetch(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
    if (this.cookies.size)
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const response = await call(
      new Request(url, {
        ...init,
        method,
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
        redirect: "manual",
      }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair!.split("=");
      const text = value.join("=");
      if (/Max-Age=0/i.test(cookie) || !text) this.cookies.delete(name!);
      else this.cookies.set(name!, text);
    }
    return response;
  }

  async json<T = Record<string, unknown>>(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ) {
    const response = await this.fetch(path, init);
    return { status: response.status, body: (await response.json()) as T, response };
  }

  /** Runs an action, as the web app does: `POST /api/actions/<id>`. */
  act<T = Record<string, unknown>>(id: string, input: unknown = {}) {
    return this.json<T>(`/api/actions/${id}`, { json: input });
  }
}

let counter = 0;

/** A unique e2e-style address on the reserved domain, so its mail is captured. */
export function testEmail(name = "user"): string {
  return `${name}+${Date.now()}${++counter}@threepigs.example`;
}

export async function mailTo(to: string): Promise<CapturedMail[]> {
  const response = await call(
    new Request(`${ORIGIN}/api/test/mail?to=${encodeURIComponent(to)}`, {
      headers: { authorization: "Bearer test-mail-secret" },
    }),
  );
  return ((await response.json()) as { mail: CapturedMail[] }).mail;
}

/** The token in the newest `?token=` link mailed to `to` (verify, reset, change email). */
export async function linkToken(to: string): Promise<string> {
  const mail = (await mailTo(to)).find((m) => m.link && new URL(m.link).searchParams.has("token"));
  if (!mail?.link) throw new Error(`No mail with a link to ${to}`);
  return new URL(mail.link).searchParams.get("token")!;
}

/**
 * Signs up a new person and names their company on `/onboarding` (unless `company` is null), as
 * every person in a company did.
 */
export async function signUp(
  browser = new Browser(),
  name = "Bea Brickley",
  company: string | null = `${name}'s company`,
) {
  const email = testEmail(name.split(" ")[0]!.toLowerCase());
  const password = "brick-by-brick";
  const signUp = await browser.json("/api/auth/sign-up", { json: { name, email, password } });
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${JSON.stringify(signUp.body)}`);
  if (company !== null) {
    const created = await browser.json("/api/organizations", { json: { name: company } });
    if (created.status !== 200)
      throw new Error(`creating the company failed: ${JSON.stringify(created.body)}`);
  }
  return { browser, email, password };
}

export async function verify(browser: Browser, email: string) {
  const result = await browser.json("/api/auth/verify-email", {
    json: { token: await linkToken(email) },
  });
  if (result.status !== 200) throw new Error(`verify failed: ${JSON.stringify(result.body)}`);
}
