import {
  ActionError,
  personalOrganizationName,
  uuidv7,
  type MemberProfile,
  type Profile,
  type ProfileUpdateInput,
  type Role,
  type SignInInput,
  type SignUpInput,
} from "@template/contracts";
import {
  and,
  authIdentities,
  contextForEmail,
  eq,
  emailTokens,
  gt,
  inArray,
  isNull,
  lt,
  memberships,
  NO_ORGANIZATION,
  organizations,
  ownOrganizations,
  sessions,
  setContext,
  tenantSettings,
  users,
  violatedConstraint,
  sqlState,
  type Database,
  type EmailTokenPurpose,
  type TenantContext,
} from "@template/db";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashToken,
  needsRehash,
  randomToken,
  verifyPassword,
} from "./crypto";
import { Organizations } from "./organizations";
import { assertPassword } from "./passwords";
import {
  forgetCachedSessionsFor,
  selectProfile,
  Sessions,
  toAccount,
  toProfile,
  type SessionDetails,
} from "./sessions";

const HOUR_MS = 60 * 60_000;
/** How long each emailed link works. */
export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify: 24 * HOUR_MS,
  reset: HOUR_MS,
  change_email: HOUR_MS,
};
/** A deleted account is removed for good this long after the person deletes it. */
export const DELETED_ACCOUNT_RETENTION_MS = 30 * 24 * HOUR_MS;

export type SignedIn = {
  userId: string;
  /** The organization the new session opened: their most recently used one, or none yet. */
  organizationId: string | null;
  session: { token: string; cookie: string };
};

export type GoogleClaims = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

const WRONG_PASSWORD = "That email and password don't match an account.";

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (sqlState(error) !== "23505") return false;
  return (
    !constraint || violatedConstraint(error) === null || violatedConstraint(error) === constraint
  );
}

export { personalOrganizationName };

/**
 * Everything that reads or writes the identity tables (`users`, `auth_identities`, `sessions`,
 * `email_tokens`). Route handlers call these; nothing else touches those tables.
 */
export type OrganizationMember = { id: string; name: string; email: string; role: Role };

export class Accounts {
  readonly sessions: Sessions;
  readonly organizations: Organizations;

  constructor(
    private readonly db: Database,
    private readonly pepper: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.sessions = new Sessions(db, pepper, clock);
    this.organizations = new Organizations(db, pepper, this.sessions, clock);
  }

  private now(): Date {
    return new Date(this.clock());
  }

  private async newEmailToken(userId: string, purpose: EmailTokenPurpose, email: string) {
    const token = randomToken();
    const now = this.clock();
    return {
      token,
      values: {
        tokenHash: await hashToken(token, this.pepper),
        userId,
        purpose,
        newEmail: email,
        createdAt: new Date(now),
        expiresAt: new Date(now + EMAIL_TOKEN_TTL_MS[purpose]),
      },
    };
  }

  /**
   * Creates the person, the verification token and the session, in one transaction and one round
   * trip. No organization: `/onboarding` names their company next, or an invitation brings them
   * into one (`specs/organizations.md`, "Onboarding and sign-up").
   */
  async signUp(
    input: SignUpInput,
    userAgent: string | null,
  ): Promise<SignedIn & { verifyToken: string }> {
    assertPassword(input.password, "password", { email: input.email, name: input.name });
    const userId = uuidv7();
    const [passwordHash, session, verify] = await Promise.all([
      hashPassword(input.password),
      this.sessions.prepare(userId, null, userAgent),
      this.newEmailToken(userId, "verify", input.email),
    ]);
    try {
      await this.db.batch(
        (d) => [
          d
            .insert(users)
            .values({ id: userId, email: input.email, name: input.name, passwordHash }),
          d.insert(emailTokens).values(verify.values),
          d.insert(sessions).values(session.values),
        ],
        undefined,
        { name: "auth.signUp" },
      );
    } catch (error) {
      if (isUniqueViolation(error, "users_email_unique"))
        throw new ActionError(
          "conflict",
          "An account with that email already exists. Sign in instead.",
          { email: "An account with that email already exists." },
        );
      throw error;
    }
    return {
      userId,
      organizationId: null,
      session: { token: session.token, cookie: session.cookie },
      verifyToken: verify.token,
    };
  }

  /**
   * Email and password. An unknown email costs the same time as a wrong password (the dummy
   * hash). The person and the organization to open (their most recently used one, or none) come
   * back in one round trip.
   */
  async signIn(input: SignInInput, userAgent: string | null): Promise<SignedIn> {
    const [, rows, own] = await this.db.batch(
      (d) => [
        contextForEmail(d, input.email),
        d
          .select({
            id: users.id,
            passwordHash: users.passwordHash,
            deletedAt: users.deletedAt,
          })
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1),
        ownOrganizations(d),
      ],
      undefined,
      { name: "auth.signIn" },
    );
    const row = rows[0];
    const valid = await verifyPassword(input.password, row?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!row || !row.passwordHash || !valid || row.deletedAt)
      throw new ActionError("unauthenticated", WRONG_PASSWORD);
    const organizationId = own[0]?.id ?? null;
    const session = await this.sessions.prepare(row.id, organizationId, userAgent);
    const rehash = needsRehash(row.passwordHash) ? await hashPassword(input.password) : null;
    await this.db.batch((d) => [
      d.insert(sessions).values(session.values),
      ...(rehash
        ? [d.update(users).set({ passwordHash: rehash }).where(eq(users.id, row.id))]
        : []),
    ]);
    return {
      userId: row.id,
      organizationId,
      session: { token: session.token, cookie: session.cookie },
    };
  }

  /** Signs a known person in to their most recently used organization, or none (after Google, say). */
  async startSession(userId: string, userAgent: string | null): Promise<SignedIn> {
    const own = await this.db.one((d) => ownOrganizations(d), {
      "app.organization_id": NO_ORGANIZATION,
      "app.user_id": userId,
    });
    const organizationId = own[0]?.id ?? null;
    return {
      userId,
      organizationId,
      session: await this.sessions.create(userId, organizationId, userAgent),
    };
  }

  /** The profile of the person in a live organization they belong to: one statement. */
  async profile(context: TenantContext): Promise<MemberProfile> {
    const rows = await this.db.one(
      (d) =>
        selectProfile(d, {})
          .where(
            and(
              eq(users.id, context.userId),
              eq(memberships.organizationId, context.organizationId),
              isNull(users.deletedAt),
            ),
          )
          .limit(1),
      tenantSettings(context),
      { name: "profile.get" },
    );
    if (!rows[0]) throw new ActionError("not_found", "We couldn't find your profile.");
    return toProfile(rows[0]) as MemberProfile;
  }

  /**
   * The organization's current members, for approvers, notifications and names in run history.
   * Their emails are for sending to; they're never shown to the model or logged.
   */
  async members(context: TenantContext): Promise<OrganizationMember[]> {
    const rows = await this.db.one(
      (d) =>
        d
          .select({ id: users.id, name: users.name, email: users.email, role: memberships.role })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(eq(memberships.organizationId, context.organizationId), isNull(users.deletedAt)),
          )
          .orderBy(users.name),
      tenantSettings(context),
      { name: "members.list" },
    );
    return rows;
  }

  /** Name and job title. One round trip: the update and the read that returns the profile. */
  async updateProfile(context: TenantContext, input: ProfileUpdateInput): Promise<MemberProfile> {
    const changes: Partial<typeof users.$inferInsert> = { updatedAt: this.now() };
    if (input.name !== undefined) changes.name = input.name;
    if (input.title !== undefined) changes.title = input.title === "" ? null : input.title;
    const [, rows] = await this.db.batch(
      (d) => [
        d
          .update(users)
          .set(changes)
          .where(and(eq(users.id, context.userId), isNull(users.deletedAt))),
        selectProfile(d, {})
          .where(
            and(
              eq(users.id, context.userId),
              eq(memberships.organizationId, context.organizationId),
              isNull(users.deletedAt),
            ),
          )
          .limit(1),
      ],
      tenantSettings(context),
      { name: "profile.update" },
    );
    if (!rows[0]) throw new ActionError("not_found", "We couldn't find your profile.");
    return toProfile(rows[0]) as MemberProfile;
  }

  /** The account details the profile page shows (password set, Google linked). */
  async account(context: TenantContext): Promise<SessionDetails["account"]> {
    const rows = await this.db.one(
      (d) =>
        selectProfile(d, {})
          .where(
            and(
              eq(users.id, context.userId),
              eq(memberships.organizationId, context.organizationId),
            ),
          )
          .limit(1),
      tenantSettings(context),
    );
    if (!rows[0]) throw new ActionError("not_found", "We couldn't find your account.");
    return toAccount(rows[0]);
  }

  private async user(userId: string) {
    const rows = await this.db.one((d) =>
      d
        .select()
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1),
    );
    if (!rows[0]) throw new ActionError("unauthenticated", "Sign in to continue.");
    return rows[0];
  }

  private async checkPassword(stored: string | null, password: string | undefined, field: string) {
    if (!stored) return;
    if (!password || !(await verifyPassword(password, stored)))
      throw new ActionError("invalid_input", "That password isn't right.", {
        [field]: "That password isn't right.",
      });
  }

  /** A new verification link for the person's current email, or null if it's already verified. */
  async resendVerification(userId: string): Promise<{ email: string; token: string } | null> {
    const user = await this.user(userId);
    if (user.emailVerifiedAt) return null;
    const verify = await this.newEmailToken(userId, "verify", user.email);
    await this.db.one((d) => d.insert(emailTokens).values(verify.values));
    return { email: user.email, token: verify.token };
  }

  /** A reset link for the email, or null when no account has it (the caller says the same either way). */
  async requestPasswordReset(
    email: string,
  ): Promise<{ userId: string; email: string; token: string } | null> {
    const rows = await this.db.one((d) =>
      d
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.deletedAt)))
        .limit(1),
    );
    const user = rows[0];
    if (!user) return null;
    const reset = await this.newEmailToken(user.id, "reset", user.email);
    await this.db.one((d) => d.insert(emailTokens).values(reset.values));
    return { userId: user.id, email: user.email, token: reset.token };
  }

  /**
   * Sets a new password from a reset link. The link proves the inbox, so the email counts as
   * verified. Every session ends; the caller also revokes the person's OAuth grants.
   */
  async resetPassword(token: string, password: string): Promise<{ userId: string }> {
    const tokenHash = await hashToken(token, this.pepper);
    const passwordHash = await hashPassword(password);
    const now = this.now();
    const userId = await this.db.transaction(async (d) => {
      const [row] = await d
        .select({
          userId: emailTokens.userId,
          email: users.email,
          newEmail: emailTokens.newEmail,
          verifiedAt: users.emailVerifiedAt,
        })
        .from(emailTokens)
        .innerJoin(users, eq(users.id, emailTokens.userId))
        .where(
          and(
            eq(emailTokens.tokenHash, tokenHash),
            eq(emailTokens.purpose, "reset"),
            isNull(emailTokens.usedAt),
            gt(emailTokens.expiresAt, now),
            isNull(users.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!row)
        throw new ActionError(
          "invalid_input",
          "This reset link has expired or was already used. Ask for a new one.",
        );
      assertPassword(password, "password", { email: row.email });
      await d
        .update(users)
        .set({
          passwordHash,
          updatedAt: now,
          ...(!row.verifiedAt && row.newEmail === row.email ? { emailVerifiedAt: now } : {}),
        })
        .where(eq(users.id, row.userId));
      await d
        .update(emailTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(emailTokens.userId, row.userId),
            eq(emailTokens.purpose, "reset"),
            isNull(emailTokens.usedAt),
          ),
        );
      await d.delete(sessions).where(eq(sessions.userId, row.userId));
      return row.userId;
    });
    forgetCachedSessionsFor(userId);
    return { userId };
  }

  /**
   * Consumes a verify or change-email link. A verify link counts only for the address it was
   * sent to; a change-email link moves the account to its new address.
   */
  async confirmEmail(token: string): Promise<{
    userId: string;
    purpose: "verify" | "change_email";
    email: string;
    oldEmail: string;
  }> {
    const tokenHash = await hashToken(token, this.pepper);
    const now = this.now();
    try {
      const result = await this.db.transaction(async (d) => {
        const [row] = await d
          .select({
            userId: emailTokens.userId,
            purpose: emailTokens.purpose,
            newEmail: emailTokens.newEmail,
            email: users.email,
          })
          .from(emailTokens)
          .innerJoin(users, eq(users.id, emailTokens.userId))
          .where(
            and(
              eq(emailTokens.tokenHash, tokenHash),
              inArray(emailTokens.purpose, ["verify", "change_email"]),
              isNull(emailTokens.usedAt),
              gt(emailTokens.expiresAt, now),
              isNull(users.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        const expired = new ActionError(
          "invalid_input",
          "This link has expired or was already used. Ask for a new one from your profile.",
        );
        if (!row || !row.newEmail) throw expired;
        if (row.purpose === "verify") {
          if (row.newEmail.toLowerCase() !== row.email.toLowerCase()) throw expired;
          await d.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, row.userId));
        } else {
          await d
            .update(users)
            .set({ email: row.newEmail, emailVerifiedAt: now, updatedAt: now })
            .where(eq(users.id, row.userId));
        }
        await d
          .update(emailTokens)
          .set({ usedAt: now })
          .where(
            and(
              eq(emailTokens.userId, row.userId),
              eq(emailTokens.purpose, row.purpose),
              isNull(emailTokens.usedAt),
            ),
          );
        return {
          userId: row.userId,
          purpose: row.purpose as "verify" | "change_email",
          email: row.newEmail,
          oldEmail: row.email,
        };
      });
      // Cached sessions still say the old email and that it's unverified.
      forgetCachedSessionsFor(result.userId);
      return result;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ActionError("conflict", "That email now belongs to another account.");
      throw error;
    }
  }

  /** Starts an email change: needs the current password; the link goes to the new address. */
  async requestEmailChange(
    userId: string,
    newEmail: string,
    currentPassword: string,
  ): Promise<{ token: string; oldEmail: string; newEmail: string }> {
    const user = await this.user(userId);
    if (!user.passwordHash)
      throw new ActionError("invalid_input", "Set a password before changing your email.");
    await this.checkPassword(user.passwordHash, currentPassword, "currentPassword");
    if (user.email.toLowerCase() === newEmail.toLowerCase())
      throw new ActionError("invalid_input", "That's already your email.", {
        email: "That's already your email.",
      });
    const taken = await this.db.one((d) =>
      d.select({ id: users.id }).from(users).where(eq(users.email, newEmail)).limit(1),
    );
    if (taken.length)
      throw new ActionError("conflict", "Another account uses that email.", {
        email: "Another account uses that email.",
      });
    const change = await this.newEmailToken(userId, "change_email", newEmail);
    await this.db.one((d) => d.insert(emailTokens).values(change.values));
    return { token: change.token, oldEmail: user.email, newEmail };
  }

  /** Changes the password and ends every other session. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepTokenHash: string,
  ): Promise<void> {
    const user = await this.user(userId);
    if (!user.passwordHash)
      throw new ActionError("invalid_input", "You don't have a password yet. Set one instead.");
    await this.checkPassword(user.passwordHash, currentPassword, "currentPassword");
    assertPassword(newPassword, "newPassword", { email: user.email });
    const passwordHash = await hashPassword(newPassword);
    await this.db.batch((d) => [
      d.update(users).set({ passwordHash, updatedAt: this.now() }).where(eq(users.id, userId)),
      this.sessions.endAllStatement(d, userId, keepTokenHash),
    ]);
  }

  /** A first password, for an account that only had Google. */
  async setPassword(userId: string, newPassword: string): Promise<void> {
    const user = await this.user(userId);
    assertPassword(newPassword, "newPassword", { email: user.email });
    const passwordHash = await hashPassword(newPassword);
    const updated = await this.db.one((d) =>
      d
        .update(users)
        .set({ passwordHash, updatedAt: this.now() })
        .where(and(eq(users.id, userId), isNull(users.passwordHash)))
        .returning({ id: users.id }),
    );
    if (!updated.length)
      throw new ActionError("conflict", "You already have a password. Change it instead.");
  }

  /** Unlinks Google; only once a password exists, so the person can still sign in. */
  async unlinkGoogle(userId: string): Promise<void> {
    const user = await this.user(userId);
    if (!user.passwordHash)
      throw new ActionError(
        "invalid_input",
        "Set a password before unlinking Google, so you can still sign in.",
      );
    await this.db.one((d) =>
      d
        .delete(authIdentities)
        .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, "google"))),
    );
  }

  /**
   * Deletes the account now (soft: `deleted_at`, every session ended). The caller revokes OAuth
   * grants. `purgeDeletedAccounts` removes it for good after `DELETED_ACCOUNT_RETENTION_MS`.
   *
   * Refused while the person is the last owner of a company with other members: they make
   * someone else an owner first (`deletionBlockers` lists those companies). Companies where
   * they're the only member are deleted with the account.
   */
  async deleteAccount(userId: string, currentPassword: string | undefined): Promise<void> {
    const user = await this.user(userId);
    await this.checkPassword(user.passwordHash, currentPassword, "currentPassword");
    const { blockers, alone } = await this.organizations.soleOwnerships(userId);
    if (blockers.length)
      throw new ActionError(
        "conflict",
        `You're the only owner of ${blockers.map((o) => o.name).join(", ")}. Make someone else an owner there first.`,
      );
    await this.db.batch((d) => [
      d.update(users).set({ deletedAt: this.now() }).where(eq(users.id, userId)),
      this.sessions.endAllStatement(d, userId),
      ...alone.flatMap((organization) => [
        setContext(d, { organizationId: organization.id, userId }),
        d
          .update(organizations)
          .set({ deletedAt: this.now(), updatedAt: this.now() })
          .where(eq(organizations.id, organization.id)),
      ]),
    ]);
  }

  /**
   * The cleanup cron: removes accounts deleted more than 30 days ago. For each, it leaves every
   * organization (as that organization, so row-level security applies), deletes organizations
   * nobody is left in, then deletes the person (their sessions, tokens and identities cascade).
   * Returns the ids it removed.
   */
  async purgeDeletedAccounts(
    limit = 100,
    options: {
      /**
       * Runs first, for each person, with the organizations they're in: whatever the person owns
       * outside this database (their Assistant conversations' Durable Objects) goes before them.
       */
      beforeRemove?: (userId: string, organizationIds: string[]) => Promise<void>;
    } = {},
  ): Promise<string[]> {
    const cutoff = new Date(this.clock() - DELETED_ACCOUNT_RETENTION_MS);
    const due = await this.db.one((d) =>
      d.select({ id: users.id }).from(users).where(lt(users.deletedAt, cutoff)).limit(limit),
    );
    const removed: string[] = [];
    for (const { id: userId } of due) {
      if (options.beforeRemove) {
        const own = await this.db.one(
          (d) =>
            d
              .select({ organizationId: memberships.organizationId })
              .from(memberships)
              .where(eq(memberships.userId, userId)),
          { "app.organization_id": NO_ORGANIZATION, "app.user_id": userId },
        );
        await options.beforeRemove(
          userId,
          own.map((m) => m.organizationId),
        );
      }
      await this.db.transaction(
        async (d) => {
          const own = await d
            .select({ organizationId: memberships.organizationId })
            .from(memberships)
            .where(eq(memberships.userId, userId));
          for (const { organizationId } of own) {
            await setContext(d, { organizationId, userId }).execute();
            await d
              .delete(memberships)
              .where(
                and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)),
              );
            const left = await d
              .select({ userId: memberships.userId })
              .from(memberships)
              .where(eq(memberships.organizationId, organizationId))
              .limit(1);
            if (!left.length)
              await d.delete(organizations).where(eq(organizations.id, organizationId));
          }
          await d.delete(users).where(eq(users.id, userId));
        },
        { "app.organization_id": NO_ORGANIZATION, "app.user_id": userId },
      );
      removed.push(userId);
    }
    return removed;
  }

  /**
   * Continue with Google: a known Google identity signs in; a verified Google email that matches
   * an account links to it; otherwise a new account is created, already verified. An unverified
   * Google email is refused.
   */
  async signInWithGoogle(
    claims: GoogleClaims,
    userAgent: string | null,
  ): Promise<SignedIn & { created: boolean; linked: boolean }> {
    const email = claims.email.trim().toLowerCase();
    const [byIdentity, byEmail] = await this.db.batch((d) => [
      d
        .select({ id: users.id, deletedAt: users.deletedAt })
        .from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .where(
          and(eq(authIdentities.provider, "google"), eq(authIdentities.providerUserId, claims.sub)),
        )
        .limit(1),
      d
        .select({
          id: users.id,
          deletedAt: users.deletedAt,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1),
    ]);
    const deleted = new ActionError(
      "forbidden",
      "This account was deleted. Contact us within 30 days if you want it back.",
    );
    const known = byIdentity[0];
    if (known) {
      if (known.deletedAt) throw deleted;
      return { ...(await this.startSession(known.id, userAgent)), created: false, linked: false };
    }
    if (!claims.emailVerified)
      throw new ActionError(
        "forbidden",
        "Google hasn't verified this email address. Sign up with email and password instead.",
      );
    const existing = byEmail[0];
    if (existing) {
      if (existing.deletedAt) throw deleted;
      await this.db.batch((d) => [
        d.insert(authIdentities).values({
          provider: "google",
          providerUserId: claims.sub,
          userId: existing.id,
          email,
        }),
        ...(existing.emailVerifiedAt
          ? []
          : [
              d.update(users).set({ emailVerifiedAt: this.now() }).where(eq(users.id, existing.id)),
            ]),
      ]);
      return { ...(await this.startSession(existing.id, userAgent)), created: false, linked: true };
    }
    const userId = uuidv7();
    const name = claims.name?.trim() || email.split("@")[0]!;
    const session = await this.sessions.prepare(userId, null, userAgent);
    try {
      await this.db.batch((d) => [
        d.insert(users).values({
          id: userId,
          email,
          name,
          avatarUrl: claims.picture,
          emailVerifiedAt: this.now(),
        }),
        d
          .insert(authIdentities)
          .values({ provider: "google", providerUserId: claims.sub, userId, email }),
        d.insert(sessions).values(session.values),
      ]);
    } catch (error) {
      // Two Google callbacks raced; the other one created the account.
      if (isUniqueViolation(error)) return this.signInWithGoogle(claims, userAgent);
      throw error;
    }
    return {
      userId,
      organizationId: null,
      session: { token: session.token, cookie: session.cookie },
      created: true,
      linked: false,
    };
  }
}
