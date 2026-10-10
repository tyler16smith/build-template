import { describe, expect, it, beforeEach } from "vitest";
import type { Profile, SessionView } from "@template/contracts";
import { Browser, linkToken, mailTo, resetDatabase, signUp, verify } from "./helpers";

beforeEach(resetDatabase);

describe("sign-up, the session and the profile", () => {
  it("signs up, loads the session in one call, and updates the profile through the action", async () => {
    const { browser, email } = await signUp();
    expect(browser.cookies.has("__Host-session")).toBe(true);
    const session = await browser.json<SessionView>("/api/session");
    expect(session.body.profile).toMatchObject({
      name: "Bea Brickley",
      email,
      emailVerified: false,
      role: "owner",
      organization: { name: "Bea Brickley's company" },
    });
    expect(session.body.signInMethods).toEqual(["password"]);
    expect(session.body.mcpUrl).toBe("https://app.test/mcp");

    const updated = await browser.json<Profile>("/api/actions/profile.update", {
      json: { title: 'Founder. "Measures twice, mortars once."' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toMatch(/^Founder/);

    const bad = await browser.json<{ error: { code: string; fields: Record<string, string> } }>(
      "/api/actions/profile.update",
      { json: { name: "" } },
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_input");
    expect(bad.body.error.fields.name).toBe("Enter your name.");
  });

  it("refuses a duplicate email and a weak password", async () => {
    const { email } = await signUp();
    const again = await new Browser().json<{ error: { code: string } }>("/api/auth/sign-up", {
      json: { name: "Imposter", email, password: "another-good-password" },
    });
    expect(again.body.error.code).toBe("conflict");
    const weak = await new Browser().json<{ error: { code: string } }>("/api/auth/sign-up", {
      json: { name: "Weak", email: "weak@threepigs.example", password: "password123" },
    });
    expect(weak.body.error.code).toBe("invalid_input");
  });

  it("verifies the email from the mailed link", async () => {
    const { browser, email } = await signUp();
    const [mail] = await mailTo(email);
    expect(mail?.subject).toMatch(/Verify your email/);
    await verify(browser, email);
    const session = await browser.json<SessionView>("/api/session");
    expect(session.body.profile?.emailVerified).toBe(true);
  });

  it("signs out, signs in, and refuses a wrong password", async () => {
    const { browser, email, password } = await signUp();
    await browser.json("/api/auth/sign-out", { json: {} });
    expect((await browser.json<SessionView>("/api/session")).body.profile).toBeNull();
    const wrong = await browser.json<{ error: { code: string } }>("/api/auth/sign-in", {
      json: { email, password: "not-my-password" },
    });
    expect(wrong.status).toBe(401);
    const right = await browser.json("/api/auth/sign-in", { json: { email, password } });
    expect(right.status).toBe(200);
    expect((await browser.json<SessionView>("/api/session")).body.profile?.email).toBe(email);
  });

  it("resets a forgotten password and signs out every session", async () => {
    const { browser, email } = await signUp();
    const other = new Browser();
    expect((await other.json("/api/auth/forgot-password", { json: { email } })).status).toBe(200);
    const token = await linkToken(email);
    const reset = await other.json("/api/auth/reset-password", {
      json: { token, password: "a-brand-new-password" },
    });
    expect(reset.status).toBe(200);
    expect((await browser.json<SessionView>("/api/session")).body.profile).toBeNull();
    const signIn = await other.json("/api/auth/sign-in", {
      json: { email, password: "a-brand-new-password" },
    });
    expect(signIn.status).toBe(200);
  });

  it("says the same thing for a reset of an unknown email", async () => {
    const result = await new Browser().json("/api/auth/forgot-password", {
      json: { email: "nobody@threepigs.example" },
    });
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(await mailTo("nobody@threepigs.example")).toEqual([]);
  });

  it("changes the email through the new address, and tells the old one", async () => {
    const { browser, email, password } = await signUp();
    const newEmail = email.replace("bea", "brickley");
    const result = await browser.json("/api/auth/change-email", {
      json: { email: newEmail, currentPassword: password },
    });
    expect(result.status).toBe(200);
    expect((await mailTo(email))[0]?.subject).toMatch(/is changing/);
    await browser.json("/api/auth/verify-email", { json: { token: await linkToken(newEmail) } });
    const session = await browser.json<SessionView>("/api/session");
    expect(session.body.profile).toMatchObject({ email: newEmail, emailVerified: true });
  });

  it("deletes the account and signs out", async () => {
    const { browser, email, password } = await signUp();
    const result = await browser.json("/api/auth/delete-account", {
      json: { currentPassword: password, confirm: "DELETE" },
    });
    expect(result.status).toBe(200);
    expect((await browser.json<SessionView>("/api/session")).body.profile).toBeNull();
    const signIn = await browser.json("/api/auth/sign-in", { json: { email, password } });
    expect(signIn.status).toBe(401);
  });
});

describe("Continue with Google", () => {
  it("is off until configured", async () => {
    const response = await new Browser().fetch("/auth/google/start");
    expect(response.status).toBe(404);
  });
});
