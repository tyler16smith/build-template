import { ActionError } from "@template/contracts";
import { Database, eq, organizations, sessions, users } from "@template/db";
import { createTestPostgres, truncateAll, type TestPostgres } from "@template/db/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Accounts,
  base64UrlEncode,
  base64UrlEncodeText,
  clearSessionCache,
  DELETED_ACCOUNT_RETENTION_MS,
  passwordProblem,
  personalOrganizationName,
  readSignedCookie,
  resetGoogleKeyCache,
  safeReturnTo,
  SESSION_IDLE_MS,
  signedCookie,
  verifyGoogleIdToken,
  verifyPassword,
  hashPassword,
} from "../src";

const PEPPER = "test-pepper";
let test: TestPostgres;
let owner: Database;
let now = Date.parse("2026-10-01T12:00:00Z");
const clock = () => now;
let accounts: Accounts;

const BEA = { name: "Bea Brickley", email: "bea@threepigs.example", password: "brick-by-brick" };

beforeAll(async () => {
  test = await createTestPostgres();
  owner = new Database(test.owner);
});
afterAll(() => test.close());
beforeEach(async () => {
  await truncateAll(test);
  clearSessionCache();
  now = Date.parse("2026-10-01T12:00:00Z");
  accounts = new Accounts(test.db, PEPPER, clock);
});

/** Signs up, then names the company on `/onboarding`: what every person in a company did. */
async function signUpWithCompany(person = BEA, name = personalOrganizationName(person.name)) {
  const signed = await accounts.signUp(person, null);
  const sessionHash = await accounts.sessions.hash(signed.session.token);
  const organization = await accounts.organizations.create(signed.userId, { name }, sessionHash);
  return { ...signed, organizationId: organization.id, organization, sessionHash };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ActionError) return error.code;
    throw error;
  }
  return "ok";
}

describe("passwords", () => {
  it("hashes with PBKDF2 and verifies", async () => {
    const hash = await hashPassword("correct horse battery", 1000);
    expect(hash).toMatch(/^pbkdf2\$1000\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
  });

  it("refuses short and common passwords", () => {
    expect(passwordProblem("short")).toMatch(/at least 10/);
    expect(passwordProblem("password123")).toMatch(/too common/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/common|variety/);
    expect(passwordProblem("chinny-chin-chin")).toBeNull();
  });
});

describe("sign-up and sign-in", () => {
  it("creates the person and a session, and no company until they name one", async () => {
    const signed = await accounts.signUp(BEA, "test-agent");
    expect(signed.organizationId).toBeNull();
    expect(signed.session.cookie).toMatch(
      /^__Host-session=.+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );
    const before = await accounts.sessions.details(signed.session.token);
    expect(before?.profile).toMatchObject({
      name: "Bea Brickley",
      email: BEA.email,
      emailVerified: false,
      title: null,
      role: null,
      organization: null,
    });
    expect(before?.organizations).toEqual([]);
    expect(before?.account).toEqual({ hasPassword: true, google: { linked: false, email: null } });

    const created = await accounts.organizations.create(
      signed.userId,
      { name: "Bea Brickley's company" },
      await accounts.sessions.hash(signed.session.token),
    );
    expect(created.slug).toBe("bea-brickley-s-company");
    const after = await accounts.sessions.details(signed.session.token);
    expect(after?.profile).toMatchObject({
      role: "owner",
      organization: { id: created.id, name: "Bea Brickley's company" },
    });
    expect(after?.organizations.map((o) => [o.name, o.role])).toEqual([
      ["Bea Brickley's company", "owner"],
    ]);
  });

  it("refuses a second account with the same email, in any case", async () => {
    await accounts.signUp(BEA, null);
    expect(await code(accounts.signUp({ ...BEA, email: "BEA@threepigs.example" }, null))).toBe(
      "conflict",
    );
  });

  it("signs in with the password, and gives the same answer for a wrong password or unknown email", async () => {
    await signUpWithCompany();
    const signed = await accounts.signIn({ email: BEA.email, password: BEA.password }, null);
    expect(await accounts.sessions.authenticate(signed.session.token)).toMatchObject({
      userId: signed.userId,
      role: "owner",
    });
    const wrong = await accounts
      .signIn({ email: BEA.email, password: "not-the-password" }, null)
      .catch((e: ActionError) => e.message);
    const unknown = await accounts
      .signIn({ email: "nobody@threepigs.example", password: "not-the-password" }, null)
      .catch((e: ActionError) => e.message);
    expect(wrong).toBe(unknown);
  });

  it("names companies sensibly", () => {
    expect(personalOrganizationName("Bea")).toBe("Bea's company");
    expect(personalOrganizationName("Polly Planks")).toBe("Polly Planks' company");
  });
});

describe("sessions", () => {
  it("expires after the idle window and slides forward when half is used", async () => {
    const signed = await accounts.signUp(BEA, null);
    const identity = (await accounts.sessions.authenticate(signed.session.token))!;
    expect(await accounts.sessions.renew(identity, signed.session.token)).toBeNull();
    now += SESSION_IDLE_MS * 0.6;
    const cookie = await accounts.sessions.renew(identity, signed.session.token);
    expect(cookie).toMatch(/Max-Age=2592000/);
    now += SESSION_IDLE_MS * 0.9;
    clearSessionCache();
    expect(await accounts.sessions.authenticate(signed.session.token)).not.toBeNull();
    now += SESSION_IDLE_MS;
    clearSessionCache();
    expect(await accounts.sessions.authenticate(signed.session.token)).toBeNull();
  });

  it("ends a session on sign-out, at once in this isolate", async () => {
    const signed = await accounts.signUp(BEA, null);
    expect(await accounts.sessions.authenticate(signed.session.token)).not.toBeNull();
    await accounts.sessions.end(signed.session.token);
    expect(await accounts.sessions.authenticate(signed.session.token)).toBeNull();
  });

  it("asks the database, not this isolate's copy, when told to", async () => {
    const signed = await signUpWithCompany();
    expect(await accounts.sessions.authenticate(signed.session.token)).toMatchObject({
      organizationId: signed.organizationId,
    });
    // Another isolate opens a second company in this session.
    const other = await accounts.organizations.create(signed.userId, { name: "Second" });
    await owner.one((d) =>
      d
        .update(sessions)
        .set({ organizationId: other.id })
        .where(eq(sessions.tokenHash, signed.sessionHash)),
    );
    expect(await accounts.sessions.authenticate(signed.session.token)).toMatchObject({
      organizationId: signed.organizationId,
    });
    expect(
      await accounts.sessions.authenticate(signed.session.token, { fresh: true }),
    ).toMatchObject({ organizationId: other.id, role: "owner" });
    expect(await accounts.sessions.authenticate(signed.session.token)).toMatchObject({
      organizationId: other.id,
    });
  });

  it("opens no company once the company is gone", async () => {
    const signed = await signUpWithCompany();
    await owner.one(
      (d) => d.delete(organizations).where(eq(organizations.id, signed.organizationId)),
      {
        "app.organization_id": signed.organizationId,
      },
    );
    const details = await accounts.sessions.details(signed.session.token);
    expect(details?.identity).toMatchObject({ organizationId: null, role: null });
    expect(details?.profile.organization).toBeNull();
  });
});

describe("email flows", () => {
  it("verifies the email with the sign-up link, once", async () => {
    const signed = await accounts.signUp(BEA, null);
    expect(await accounts.confirmEmail(signed.verifyToken)).toMatchObject({ purpose: "verify" });
    expect(await code(accounts.confirmEmail(signed.verifyToken))).toBe("invalid_input");
    const details = await accounts.sessions.details(signed.session.token);
    expect(details?.profile.emailVerified).toBe(true);
  });

  it("expires the verify link after 24 hours", async () => {
    const signed = await accounts.signUp(BEA, null);
    now += 25 * 60 * 60_000;
    expect(await code(accounts.confirmEmail(signed.verifyToken))).toBe("invalid_input");
  });

  it("resets the password and ends every session", async () => {
    const signed = await accounts.signUp(BEA, null);
    const reset = await accounts.requestPasswordReset("BEA@threepigs.example");
    expect(reset?.email).toBe(BEA.email);
    expect(await accounts.requestPasswordReset("nobody@threepigs.example")).toBeNull();
    expect(await code(accounts.resetPassword(reset!.token, "short"))).toBe("invalid_input");
    await accounts.resetPassword(reset!.token, "huffing-and-puffing");
    expect(await accounts.sessions.details(signed.session.token)).toBeNull();
    expect(await code(accounts.resetPassword(reset!.token, "another-password"))).toBe(
      "invalid_input",
    );
    expect(
      await code(accounts.signIn({ email: BEA.email, password: "huffing-and-puffing" }, null)),
    ).toBe("ok");
  });

  it("changes the email through a link sent to the new address", async () => {
    const signed = await accounts.signUp(BEA, null);
    expect(
      await code(
        accounts.requestEmailChange(signed.userId, "brickley@threepigs.example", "wrong-password"),
      ),
    ).toBe("invalid_input");
    const change = await accounts.requestEmailChange(
      signed.userId,
      "brickley@threepigs.example",
      BEA.password,
    );
    expect(change.oldEmail).toBe(BEA.email);
    // The old verify link no longer counts once the address changed.
    const result = await accounts.confirmEmail(change.token);
    expect(result).toMatchObject({ purpose: "change_email", email: "brickley@threepigs.example" });
    expect(await code(accounts.confirmEmail(signed.verifyToken))).toBe("invalid_input");
    const details = await accounts.sessions.details(signed.session.token);
    expect(details?.profile).toMatchObject({
      email: "brickley@threepigs.example",
      emailVerified: true,
    });
  });
});

describe("password changes", () => {
  it("changes the password and ends the other sessions only", async () => {
    const first = await accounts.signUp(BEA, null);
    const second = await accounts.signIn({ email: BEA.email, password: BEA.password }, null);
    const identity = (await accounts.sessions.authenticate(first.session.token))!;
    await accounts.changePassword(
      first.userId,
      BEA.password,
      "new-and-improved",
      identity.tokenHash,
    );
    expect(await accounts.sessions.details(first.session.token)).not.toBeNull();
    expect(await accounts.sessions.details(second.session.token)).toBeNull();
  });
});

describe("profile", () => {
  it("updates name and title, and clears the title with an empty string", async () => {
    const signed = await signUpWithCompany();
    const context = { userId: signed.userId, organizationId: signed.organizationId };
    const updated = await accounts.updateProfile(context, {
      title: "Founder",
      name: "Bea B.",
    });
    expect(updated).toMatchObject({ name: "Bea B.", title: "Founder" });
    expect((await accounts.updateProfile(context, { title: "" })).title).toBeNull();
  });
});

describe("account deletion", () => {
  it("soft-deletes at once and purges after 30 days, with the company only they were in", async () => {
    const signed = await signUpWithCompany();
    expect(await code(accounts.deleteAccount(signed.userId, "wrong-password"))).toBe(
      "invalid_input",
    );
    await accounts.deleteAccount(signed.userId, BEA.password);
    expect(await accounts.sessions.details(signed.session.token)).toBeNull();
    expect(await code(accounts.signIn({ email: BEA.email, password: BEA.password }, null))).toBe(
      "unauthenticated",
    );
    expect(await accounts.purgeDeletedAccounts()).toEqual([]);
    now += DELETED_ACCOUNT_RETENTION_MS + 1000;
    expect(await accounts.purgeDeletedAccounts()).toEqual([signed.userId]);
    const left = await owner.one((d) => d.select().from(users).where(eq(users.id, signed.userId)));
    expect(left).toEqual([]);
    const orgs = await owner.one(
      (d) => d.select().from(organizations).where(eq(organizations.id, signed.organizationId)),
      { "app.organization_id": signed.organizationId },
    );
    expect(orgs).toEqual([]);
  });
});

describe("Continue with Google", () => {
  it("creates a verified account, signs in again with the same identity, and links by email", async () => {
    const first = await accounts.signInWithGoogle(
      {
        sub: "g-1",
        email: "stu@threepigs.example",
        emailVerified: true,
        name: "Stu Sticksworth",
        picture: null,
      },
      null,
    );
    expect(first.created).toBe(true);
    const details = await accounts.sessions.details(first.session.token);
    expect(details?.profile).toMatchObject({ name: "Stu Sticksworth", emailVerified: true });
    expect(details?.account).toEqual({
      hasPassword: false,
      google: { linked: true, email: "stu@threepigs.example" },
    });
    const again = await accounts.signInWithGoogle(
      {
        sub: "g-1",
        email: "stu@threepigs.example",
        emailVerified: true,
        name: null,
        picture: null,
      },
      null,
    );
    expect(again).toMatchObject({ created: false, userId: first.userId });

    const bea = await accounts.signUp(BEA, null);
    const linked = await accounts.signInWithGoogle(
      { sub: "g-2", email: BEA.email, emailVerified: true, name: "Bea", picture: null },
      null,
    );
    expect(linked).toMatchObject({ linked: true, userId: bea.userId });
  });

  it("refuses an unverified Google email", async () => {
    expect(
      await code(
        accounts.signInWithGoogle(
          {
            sub: "g-3",
            email: "x@bigbad.example",
            emailVerified: false,
            name: null,
            picture: null,
          },
          null,
        ),
      ),
    ).toBe("forbidden");
  });

  it("lets a Google-only account set a password, then unlink Google", async () => {
    const signed = await accounts.signInWithGoogle(
      {
        sub: "g-4",
        email: "mort@threepigs.example",
        emailVerified: true,
        name: "Barb",
        picture: null,
      },
      null,
    );
    expect(await code(accounts.unlinkGoogle(signed.userId))).toBe("invalid_input");
    await accounts.setPassword(signed.userId, "two-metre-vent");
    expect(await code(accounts.setPassword(signed.userId, "another-password"))).toBe("conflict");
    await accounts.unlinkGoogle(signed.userId);
    const details = await accounts.sessions.details(signed.session.token);
    expect(details?.account).toEqual({ hasPassword: true, google: { linked: false, email: null } });
  });

  it("verifies ID tokens: signature, audience, expiry and nonce", async () => {
    resetGoogleKeyCache();
    const { publicKey, privateKey } = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
    const fetcher = async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "cache-control": "max-age=600" },
      });
    const sign = async (claims: Record<string, unknown>) => {
      const header = base64UrlEncodeText(JSON.stringify({ alg: "RS256", kid: "k1" }));
      const payload = base64UrlEncodeText(JSON.stringify(claims));
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
    };
    const claims = {
      iss: "https://accounts.google.com",
      aud: "client-1",
      exp: Math.floor(now / 1000) + 600,
      nonce: "n-1",
      sub: "g-5",
      email: "polly@threepigs.example",
      email_verified: true,
      name: "Polly Planks",
    };
    const expected = { clientId: "client-1", nonce: "n-1" };
    expect(await verifyGoogleIdToken(await sign(claims), expected, fetcher, now)).toMatchObject({
      sub: "g-5",
      emailVerified: true,
      name: "Polly Planks",
    });
    for (const bad of [
      { aud: "other" },
      { nonce: "n-2" },
      { exp: Math.floor(now / 1000) - 3600 },
      { iss: "https://evil.example" },
    ])
      expect(
        await code(verifyGoogleIdToken(await sign({ ...claims, ...bad }), expected, fetcher, now)),
      ).toBe("unauthenticated");
    const tampered = (await sign(claims)).replace(
      /\.[^.]+\./,
      `.${base64UrlEncodeText(JSON.stringify({ ...claims, sub: "g-6" }))}.`,
    );
    expect(await code(verifyGoogleIdToken(tampered, expected, fetcher, now))).toBe(
      "unauthenticated",
    );
  });

  it("keeps the return path on this origin", () => {
    expect(safeReturnTo("/oauth/consent?handle=abc")).toBe("/oauth/consent?handle=abc");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "", null])
      expect(safeReturnTo(bad)).toBe("/");
  });
});

describe("signed cookies", () => {
  it("reads back what it wrote, and nothing tampered or expired", async () => {
    const cookie = await signedCookie("__Host-google", { state: "s" }, "secret", 600);
    const header = cookie.split(";")[0]!;
    expect(await readSignedCookie(header, "__Host-google", "secret")).toMatchObject({ state: "s" });
    expect(await readSignedCookie(header, "__Host-google", "other-secret")).toBeNull();
    expect(
      await readSignedCookie(header.replace(/=./, "=x"), "__Host-google", "secret"),
    ).toBeNull();
  });
});
