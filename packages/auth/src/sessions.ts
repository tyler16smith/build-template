import type { OrganizationRef, OrganizationSummary, Profile, Role } from "@template/contracts";
import {
  and,
  authIdentities,
  contextFromSession,
  eq,
  gt,
  isNull,
  ne,
  memberships,
  organizations,
  ownOrganizations,
  sessions,
  setContext,
  users,
  type Database,
  type Drizzle,
  type MemberOrganizationRow,
  type PgColumn,
} from "@template/db";
import { sessionCookie } from "./cookies";
import { hashToken, randomToken } from "./crypto";

const DAY_MS = 24 * 60 * 60_000;
/** A session lasts 30 days without use, sliding forward while in use, up to 90 days from sign-in. */
export const SESSION_IDLE_MS = 30 * DAY_MS;
export const SESSION_CAP_MS = 90 * DAY_MS;
/** How long an isolate trusts a session it validated, before asking the database again. */
export const SESSION_CACHE_MS = 60_000;
const SESSION_CACHE_MAX = 5_000;

/**
 * Who a session belongs to: what every authenticated request needs, and nothing more. The open
 * organization and the role come from the same statement as the session, through the
 * membership: a session whose organization the person is no longer in has none.
 */
export type SessionIdentity = {
  tokenHash: string;
  userId: string;
  /** Null for a person with no company yet (`/onboarding`). */
  organizationId: string | null;
  organization: OrganizationRef | null;
  role: Role | null;
  emailVerified: boolean;
  createdAt: number;
  expiresAt: number;
  /**
   * Set when this lookup moved the session: its organization was gone (the person was removed,
   * or it was deleted), so it opened their most recently used other one, or none. The request
   * that noticed is refused (`not_a_member`); it was meant for the old organization.
   */
  movedFrom?: string;
};

/** `GET /api/session`: the identity, the profile, the account's sign-in methods and the switcher. */
export type SessionDetails = {
  identity: SessionIdentity;
  profile: Profile;
  account: { hasPassword: boolean; google: { linked: boolean; email: string | null } };
  organizations: OrganizationSummary[];
};

export function toOrganizationSummary(row: MemberOrganizationRow): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
  };
}

/**
 * Validated sessions, per isolate, keyed by token hash. Sign-out and password changes delete
 * the row and this isolate's entry; other isolates notice within `SESSION_CACHE_MS`.
 */
const cache = new Map<string, { identity: SessionIdentity; cachedAt: number }>();

export function forgetCachedSession(tokenHash: string): void {
  cache.delete(tokenHash);
}

export function forgetCachedSessionsFor(userId: string): void {
  for (const [hash, entry] of cache) if (entry.identity.userId === userId) cache.delete(hash);
}

export function clearSessionCache(): void {
  cache.clear();
}

function remember(identity: SessionIdentity, now: number): void {
  if (cache.size >= SESSION_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(identity.tokenHash, { identity, cachedAt: now });
}

type ProfileRow = {
  user: {
    id: string;
    email: string;
    name: string;
    title: string | null;
    avatarUrl: string | null;
    emailVerifiedAt: Date | null;
    passwordHash: string | null;
  };
  organization: { id: string; name: string; slug: string | null } | null;
  role: Role | null;
  googleEmail: string | null;
};

/** The profile and account fields of a user in an organization, as Drizzle select fields. */
export const profileFields = {
  user: {
    id: users.id,
    email: users.email,
    name: users.name,
    title: users.title,
    avatarUrl: users.avatarUrl,
    emailVerifiedAt: users.emailVerifiedAt,
    passwordHash: users.passwordHash,
  },
  organization: { id: organizations.id, name: organizations.name, slug: organizations.slug },
  role: memberships.role,
  googleEmail: authIdentities.email,
};

/**
 * Joins users → memberships → live organizations, and the Google identity if there is one. A
 * deleted organization is no organization: its members' profiles there stop resolving.
 */
export function selectProfile<T extends Record<string, PgColumn> = Record<never, never>>(
  d: Drizzle,
  extra: T = {} as T,
) {
  return d
    .select({ ...profileFields, ...extra })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(
      organizations,
      and(eq(organizations.id, memberships.organizationId), isNull(organizations.deletedAt)),
    )
    .leftJoin(
      authIdentities,
      and(eq(authIdentities.userId, users.id), eq(authIdentities.provider, "google")),
    );
}

export function toProfile(row: ProfileRow): Profile {
  return {
    id: row.user.id,
    name: row.user.name,
    title: row.user.title,
    email: row.user.email,
    emailVerified: row.user.emailVerifiedAt !== null,
    avatarUrl: row.user.avatarUrl,
    organization: row.organization && row.role ? { ...row.organization } : null,
    role: row.organization ? row.role : null,
  };
}

export function toAccount(row: ProfileRow): SessionDetails["account"] {
  return {
    hasPassword: row.user.passwordHash !== null,
    google: { linked: row.googleEmail !== null, email: row.googleEmail },
  };
}

export class Sessions {
  constructor(
    private readonly db: Database,
    private readonly pepper: string,
    private readonly clock: () => number = Date.now,
  ) {}

  hash(token: string): Promise<string> {
    return hashToken(token, this.pepper);
  }

  /** A new session for a person, in one of their organizations or none. Returns the cookie's token. */
  async create(
    userId: string,
    organizationId: string | null,
    userAgent: string | null,
  ): Promise<{ token: string; cookie: string }> {
    const session = await this.prepare(userId, organizationId, userAgent);
    await this.db.one((d) => d.insert(sessions).values(session.values));
    return { token: session.token, cookie: session.cookie };
  }

  private row(
    userId: string,
    organizationId: string | null,
    userAgent: string | null,
    now: number,
  ) {
    return {
      userId,
      organizationId,
      createdAt: new Date(now),
      expiresAt: new Date(now + SESSION_IDLE_MS),
      lastSeenAt: new Date(now),
      userAgent: userAgent?.slice(0, 300) ?? null,
    };
  }

  /**
   * The values for a new session row, for a batch that creates it with other rows (sign-up).
   * `cookie` is what to send back.
   */
  async prepare(userId: string, organizationId: string | null, userAgent: string | null) {
    const token = randomToken();
    const now = this.clock();
    return {
      token,
      cookie: sessionCookie(token, SESSION_IDLE_MS),
      values: {
        tokenHash: await this.hash(token),
        ...this.row(userId, organizationId, userAgent, now),
      },
    };
  }

  /** The full session (one statement), for `GET /api/session`. Refreshes the isolate cache. */
  async details(token: string): Promise<SessionDetails | null> {
    return this.detailsByHash(await this.hash(token));
  }

  /**
   * `details` by the token's hash, for a holder that never sees the token (an agent). One round
   * trip reads the session, the person, their membership in the open organization and every
   * organization they belong to. A session whose organization is gone, or that has none while
   * the person belongs to one, opens their most recently used one (a second round trip).
   */
  async detailsByHash(tokenHash: string): Promise<SessionDetails | null> {
    const now = this.clock();
    const [, rows, own] = await this.db.batch(
      (d) => [
        contextFromSession(d, tokenHash),
        d
          .select({
            ...profileFields,
            createdAt: sessions.createdAt,
            expiresAt: sessions.expiresAt,
            openOrganizationId: sessions.organizationId,
          })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .leftJoin(
            memberships,
            and(
              eq(memberships.organizationId, sessions.organizationId),
              eq(memberships.userId, sessions.userId),
            ),
          )
          .leftJoin(
            organizations,
            and(eq(organizations.id, memberships.organizationId), isNull(organizations.deletedAt)),
          )
          .leftJoin(
            authIdentities,
            and(eq(authIdentities.userId, users.id), eq(authIdentities.provider, "google")),
          )
          .where(
            and(
              eq(sessions.tokenHash, tokenHash),
              gt(sessions.expiresAt, new Date(now)),
              isNull(users.deletedAt),
            ),
          )
          .limit(1),
        ownOrganizations(d),
      ],
      undefined,
      { name: "session.details" },
    );
    let row = rows[0];
    if (!row) {
      forgetCachedSession(tokenHash);
      return null;
    }
    let movedFrom: string | undefined;
    if (!row.organization && (row.openOrganizationId || own.length)) {
      // Removed, deleted, or never opened one: open the most recently used other organization.
      const next = own.find((o) => o.id !== row!.openOrganizationId) ?? null;
      await this.open(row.user.id, tokenHash, next?.id ?? null);
      if (row.openOrganizationId) movedFrom = row.openOrganizationId;
      row = {
        ...row,
        organization: next ? { id: next.id, name: next.name, slug: next.slug } : null,
        role: next?.role ?? null,
        openOrganizationId: next?.id ?? null,
      };
    }
    const identity: SessionIdentity = {
      tokenHash,
      userId: row.user.id,
      organizationId: row.organization?.id ?? null,
      organization: row.organization ? { ...row.organization } : null,
      role: row.organization ? row.role : null,
      emailVerified: row.user.emailVerifiedAt !== null,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
    };
    remember(identity, now);
    return {
      identity: movedFrom ? { ...identity, movedFrom } : identity,
      profile: toProfile(row),
      account: toAccount(row),
      organizations: own.map(toOrganizationSummary),
    };
  }

  /**
   * Points a session at an organization (or none), and marks it the person's most recently
   * opened one. The caller has checked the membership. Drops this isolate's cached copy.
   */
  async open(userId: string, tokenHash: string, organizationId: string | null): Promise<void> {
    forgetCachedSession(tokenHash);
    const now = new Date(this.clock());
    await this.db.batch(
      (d) => [
        d
          .update(sessions)
          .set({ organizationId })
          .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, userId))),
        ...(organizationId
          ? [
              setContext(d, { organizationId, userId }),
              d
                .update(memberships)
                .set({ lastOpenedAt: now })
                .where(
                  and(
                    eq(memberships.organizationId, organizationId),
                    eq(memberships.userId, userId),
                  ),
                ),
            ]
          : []),
      ],
      undefined,
      { name: "session.open" },
    );
  }

  /**
   * Who the token belongs to: from this isolate's cache when it's fresh, else one query.
   * `fresh` skips the cache.
   */
  async authenticate(token: string, options?: { fresh: true }): Promise<SessionIdentity | null> {
    const tokenHash = await this.hash(token);
    if (options?.fresh) return (await this.detailsByHash(tokenHash))?.identity ?? null;
    return this.authenticateHash(tokenHash);
  }

  /**
   * `authenticate` by the token's hash. The Assistant's Durable Object keeps only the hash the
   * Worker gave it, and checks it again on every turn: a signed-out or expired session stops.
   */
  async authenticateHash(tokenHash: string): Promise<SessionIdentity | null> {
    const now = this.clock();
    const cached = cache.get(tokenHash);
    if (cached && now - cached.cachedAt < SESSION_CACHE_MS && cached.identity.expiresAt > now)
      return cached.identity;
    return (await this.detailsByHash(tokenHash))?.identity ?? null;
  }

  /**
   * Slides a session forward once less than half its idle window is left, never past the cap
   * from sign-in. Returns the refreshed cookie, since the browser's `Max-Age` was fixed when the
   * cookie was set, or null. The half-window threshold keeps most requests from writing.
   */
  async renew(identity: SessionIdentity, token: string): Promise<string | null> {
    const now = this.clock();
    if (identity.expiresAt - now > SESSION_IDLE_MS / 2) return null;
    const next = Math.min(now + SESSION_IDLE_MS, identity.createdAt + SESSION_CAP_MS);
    if (next <= identity.expiresAt) return null;
    await this.db.one(
      (d) =>
        d
          .update(sessions)
          .set({ expiresAt: new Date(next), lastSeenAt: new Date(now) })
          .where(eq(sessions.tokenHash, identity.tokenHash)),
      undefined,
      { name: "session.renew" },
    );
    remember({ ...identity, expiresAt: next }, now);
    return sessionCookie(token, next - now);
  }

  async end(token: string): Promise<void> {
    const tokenHash = await this.hash(token);
    forgetCachedSession(tokenHash);
    await this.db.one((d) => d.delete(sessions).where(eq(sessions.tokenHash, tokenHash)));
  }

  /**
   * Ends a person's sessions that have one organization open (they were removed from it). Their
   * sessions in other organizations carry on.
   */
  endInOrganizationStatement(d: Drizzle, userId: string, organizationId: string) {
    forgetCachedSessionsFor(userId);
    return d
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.organizationId, organizationId)));
  }

  /** Deletes every session of a person, or every one but `keepHash` (the session making the change). */
  endAllStatement(d: Drizzle, userId: string, keepHash?: string) {
    forgetCachedSessionsFor(userId);
    return keepHash
      ? d.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepHash)))
      : d.delete(sessions).where(eq(sessions.userId, userId));
  }
}
