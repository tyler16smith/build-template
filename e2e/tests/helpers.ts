import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** A throwaway address on the reserved domain (its mail is captured, never sent). */
export function e2eEmail(): string {
  const run = process.env.GITHUB_RUN_ID ?? "local";
  return `e2e+${run}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@threepigs.example`;
}

export const E2E_PASSWORD = "e2e-chinny-chin-chin";

type Mail = { to: string; subject: string; link: string | null };

/**
 * Mail sent to `to`: through the test mail hook on staging (`TEST_MAIL_SECRET`), or the dev mail
 * API locally. Retries briefly, since mail is captured as the request finishes.
 */
export async function mailTo(request: APIRequestContext, to: string): Promise<Mail[]> {
  const secret = process.env.E2E_TEST_MAIL_SECRET;
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = secret
      ? await request.get(`/api/test/mail?to=${encodeURIComponent(to)}`, {
          headers: { authorization: `Bearer ${secret}` },
        })
      : await request.get("/api/dev/mail");
    if (!response.ok()) throw new Error(`mail hook answered ${response.status()}`);
    const { mail } = (await response.json()) as { mail: Mail[] };
    const mine = mail.filter((m) => m.to === to.toLowerCase());
    if (mine.length) return mine;
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}

/** The newest link mailed to `to`, as a path on this origin. */
export async function linkFor(
  request: APIRequestContext,
  to: string,
  subject: RegExp,
): Promise<string> {
  const mail = (await mailTo(request, to)).find((m) => subject.test(m.subject));
  if (!mail?.link) throw new Error(`No "${subject}" mail to ${to}`);
  const url = new URL(mail.link);
  return `${url.pathname}${url.search}`;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(array).toString("base64url");
}

/**
 * Signs up in the browser and names the company on `/onboarding`, landing on Home. Returns the
 * email.
 */
export async function signUpWithCompany(
  page: Page,
  name: string,
  email = e2eEmail(),
): Promise<string> {
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Name your company" })).toBeVisible();
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  return email;
}

/** Deletes the signed-in account from the profile page (e2e users never pile up). */
export async function deleteAccount(page: Page): Promise<void> {
  await page.goto("/profile");
  await page.getByRole("button", { name: "Delete account" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog.getByLabel("Current password").fill(E2E_PASSWORD);
  await dialog.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
}
