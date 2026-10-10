import {
  ActionError,
  isOwnerRole,
  mayChangeMember,
  newOrganizationId,
  ROLE_ORDER,
  roleCan,
  slugify,
  type Invite,
  type InviteRole,
  type Member,
  type OrganizationRef,
  type OrganizationSummary,
  type PendingInvite,
  type Permission,
  type Role,
  uuidv7,
} from "@template/contracts";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  inviteByToken,
  invitesForEmail,
  isNotNull,
  isNull,
  lt,
  memberOrganizations,
  memberships,
  NO_ORGANIZATION,
  or,
  organizationInvites,
  organizations,
  ownOrganizations,
  sessions,
  setContext,
  sqlState,
  tenantSettings,
  users,
  violatedConstraint,
  type Database,
  type Drizzle,
  type InviteLookupRow,
  type OrganizationInviteRow,
  type TenantContext,
} from "@template/db";
import { hashToken, randomToken } from "./crypto";
import {
  forgetCachedSession,
  forgetCachedSessionsFor,
  toOrganizationSummary,
  type Sessions,
} from "./sessions";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How long an invitation link works, from when it was last sent. */
export const INVITE_TTL_MS = 7 * DAY_MS;
/** Resending one invitation: at most once a minute. */
export const INVITE_RESEND_MS = MINUTE_MS;
/** Invitations an organization may send a day, so our mail domain can't be used to spam. */
export const INVITES_PER_DAY = 50;
/** Invitations one person may send a minute. */
export const INVITES_PER_MINUTE = 10;
/** A deleted organization can be restored this long; then the cleanup cron removes it. */
export const DELETED_ORGANIZATION_RETENTION_MS = 30 * DAY_MS;
/** Accepted and expired invitations are kept this long (who invited whom), then removed. */
export const INVITE_RETENTION_MS = 90 * DAY_MS;

/** The constraint trigger that keeps an owner in every live organization (`0003`). */
const ONE_OWNER = "memberships_one_owner";

const notAMember = () =>
  new ActionError("not_a_member", "You're no longer a member of this company.");

export function lastOwnerError(organization: string): ActionError {
  return new ActionError(
    "conflict",
    `${organization} needs at least one owner. Make someone else an owner first.`,
  );
}

const expiredInvite = (invitedBy: string | null) =>
  new ActionError(
    "not_found",
    `This invitation has expired or was revoked. Ask ${invitedBy ?? "whoever invited you"} to send a new one.`,
  );

type MemberRow = { userId: string; role: Role };

/** What a membership change (role, removal, leaving, transfer) sees, in its transaction. */
type Locked = {
  organization: { id: string; name: string };
  members: MemberRow[];
  actor: MemberRow;
};

type InviteWithInviter = OrganizationInviteRow & { inviterName: string | null };

/** Owners first, then admins, then members; by name within each. */
function byRoleThenName(a: Member, b: Member): number {
  return ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name);
}

function toInvite(row: InviteWithInviter, now: number): Invite {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: { userId: row.invitedByUserId, name: row.inviterName },
    expiresAt: row.expiresAt.toISOString(),
    lastSentAt: row.lastSentAt.toISOString(),
    sendCount: row.sendCount,
    expired: row.expiresAt.getTime() <= now,
    createdAt: row.createdAt.toISOString(),
  };
}

function isLastOwnerViolation(error: unknown): boolean {
  return sqlState(error) === "23514" && violatedConstraint(error) === ONE_OWNER;
}

/**
 * Organizations, memberships and invitations (`specs/organizations.md`). The organization layer
 * knows nothing about jobs, boards or invoices: who belongs to which company, as what, and how
 * they got in. Permission checks that need a fresh role (members, ownership, deletion) happen
 * inside the transaction that writes, with the organization row locked.
 */
export class Organizations {
  constructor(
    private readonly db: Database,
    private readonly pepper: string,
    private readonly sessions: Sessions,
    private readonly clock: () => number = Date.now,
  ) {}

  private now(): Date {
    return new Date(this.clock());
  }

  // ------------------------------------------------------------ across organizations

  /** Every live organization the person belongs to, most recently opened first. */
  async list(userId: string): Promise<OrganizationSummary[]> {
    const rows = await this.db.one((d) => memberOrganizations(d, userId), {
      "app.organization_id": NO_ORGANIZATION,
      "app.user_id": userId,
    });
    return rows.map(toOrganizationSummary);
  }

  /**
   * Creates an organization with the person as its owner, and opens it in the session when one
   * is given: one round trip. `id` is for operator tooling and the seed (a central directory
   * later); everything else gets a new one. A slug that's taken gets `-2`, `-3`.
   */
  async create(
    userId: string,
    input: { name: string; slug?: string; id?: string },
    sessionHash: string | null = null,
  ): Promise<OrganizationRef> {
    const id = input.id ?? newOrganizationId();
    const base = input.slug ?? slugify(input.name);
    for (let attempt = 1; attempt <= 20; attempt++) {
      const slug = attempt === 1 ? base : `${base.slice(0, 44)}-${attempt}`;
      try {
        await this.db.batch(
          (d) => [
            setContext(d, { organizationId: id, userId }),
            d.insert(organizations).values({ id, name: input.name, slug, createdByUserId: userId }),
            d.insert(memberships).values({
              organizationId: id,
              userId,
              role: "owner",
              lastOpenedAt: this.now(),
            }),
            ...(sessionHash
              ? [
                  d
                    .update(sessions)
                    .set({ organizationId: id })
                    .where(and(eq(sessions.tokenHash, sessionHash), eq(sessions.userId, userId))),
                ]
              : []),
          ],
          undefined,
          { name: "organization.create" },
        );
        if (sessionHash) forgetCachedSession(sessionHash);
        return { id, name: input.name, slug };
      } catch (error) {
        if (sqlState(error) !== "23505" || violatedConstraint(error) !== "organizations_slug")
          throw error;
        if (input.slug)
          throw new ActionError("conflict", "That slug is taken.", { slug: "That slug is taken." });
      }
    }
    throw new ActionError("conflict", "Couldn't find a free slug. Pick one yourself.", {
      slug: "Pick a slug.",
    });
  }

  /**
   * Opens one of the person's organizations in the session (the switcher, `?org=` links). The
   * membership is checked; the session's value alone never authorizes anything.
   */
  async switch(
    userId: string,
    sessionHash: string,
    organizationId: string,
  ): Promise<OrganizationSummary> {
    const own = await this.list(userId);
    const target = own.find((o) => o.id === organizationId);
    if (!target) throw new ActionError("not_a_member", "You don't have access to that company.");
    await this.sessions.open(userId, sessionHash, target.id);
    return target;
  }

  // ------------------------------------------------------------ invitations, before joining

  /** A live invitation by its link's token, for `/invite/:token`, or null. */
  async previewInvite(token: string): Promise<InviteLookupRow | null> {
    const tokenHash = await hashToken(token, this.pepper);
    const invite = await this.db.one(
      (d) => inviteByToken(d, tokenHash),
      // Every tenant policy casts this setting; empty, as a pooled connection can leave it,
      // that cast fails before the definer's own policy lets the row through.
      { "app.organization_id": NO_ORGANIZATION },
      { name: "invite.preview" },
    );
    // The database checks expiry by its clock; this checks it by the app's too.
    return invite && invite.expiresAt.getTime() > this.clock() ? invite : null;
  }

  /**
   * Accepts an invitation from its link, as the signed-in person: their email must be the one it
   * was sent to. One transaction re-checks it, adds the membership (already a member: it just
   * opens the organization), marks it accepted, verifies the email (they read that inbox) and
   * opens the organization in the session.
   */
  async acceptInvite(
    userId: string,
    token: string,
    sessionHash: string | null,
  ): Promise<{ organization: OrganizationRef; role: Role; joined: boolean }> {
    const tokenHash = await hashToken(token, this.pepper);
    const invite = await this.db.one(
      (d) => inviteByToken(d, tokenHash),
      // Every tenant policy casts this setting; empty, as a pooled connection can leave it,
      // that cast fails before the definer's own policy lets the row through.
      { "app.organization_id": NO_ORGANIZATION },
      { name: "invite.find" },
    );
    if (!invite) throw expiredInvite(null);
    return this.accept(userId, invite, sessionHash, tokenHash);
  }

  /** Pending invitations to the person's verified email, offered on `/onboarding`. */
  async pendingInvites(userId: string, email: string): Promise<PendingInvite[]> {
    const rows = await this.db.one((d) => invitesForEmail(d, email), {
      "app.organization_id": NO_ORGANIZATION,
      "app.user_id": userId,
    });
    return rows.map((row) => ({
      id: row.id,
      organization: { id: row.organizationId, name: row.organizationName },
      invitedBy: row.invitedByName,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
    }));
  }

  /** Joins from `/onboarding` (no link): only an invitation to the person's own verified email. */
  async joinPending(
    userId: string,
    email: string,
    inviteId: string,
    sessionHash: string | null,
  ): Promise<{ organization: OrganizationRef; role: Role; joined: boolean }> {
    const rows = await this.db.one((d) => invitesForEmail(d, email), {
      "app.organization_id": NO_ORGANIZATION,
      "app.user_id": userId,
    });
    const invite = rows.find((row) => row.id === inviteId);
    if (!invite) throw expiredInvite(null);
    return this.accept(userId, invite, sessionHash, null);
  }

  private async accept(
    userId: string,
    invite: Pick<InviteLookupRow, "organizationId" | "id" | "organizationName" | "invitedByName">,
    sessionHash: string | null,
    tokenHash: string | null,
  ): Promise<{ organization: OrganizationRef; role: Role; joined: boolean }> {
    const now = this.now();
    const context = { organizationId: invite.organizationId, userId };
    const result = await this.db.transaction(
      async (d) => {
        const [row] = await d
          .select()
          .from(organizationInvites)
          .where(
            and(
              eq(organizationInvites.organizationId, invite.organizationId),
              eq(organizationInvites.id, invite.id),
              isNull(organizationInvites.acceptedAt),
              gt(organizationInvites.expiresAt, now),
              ...(tokenHash ? [eq(organizationInvites.tokenHash, tokenHash)] : []),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) throw expiredInvite(invite.invitedByName);
        const [user] = await d
          .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .limit(1);
        if (!user) throw new ActionError("unauthenticated", "Sign in to continue.");
        if (user.email.toLowerCase() !== row.email.toLowerCase())
          throw new ActionError(
            "forbidden",
            `This invitation is for ${row.email}. You're signed in as ${user.email}.`,
          );
        const [organization] = await d
          .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
          .from(organizations)
          .where(and(eq(organizations.id, invite.organizationId), isNull(organizations.deletedAt)))
          .limit(1);
        if (!organization) throw expiredInvite(invite.invitedByName);
        const inserted = await d
          .insert(memberships)
          .values({
            organizationId: invite.organizationId,
            userId,
            role: row.role,
            invitedByUserId: row.invitedByUserId,
            lastOpenedAt: now,
          })
          .onConflictDoNothing()
          .returning({ userId: memberships.userId });
        const [membership] = await d
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, invite.organizationId),
              eq(memberships.userId, userId),
            ),
          )
          .limit(1);
        await d
          .update(organizationInvites)
          .set({ acceptedAt: now, acceptedByUserId: userId })
          .where(
            and(
              eq(organizationInvites.organizationId, invite.organizationId),
              eq(organizationInvites.id, invite.id),
            ),
          );
        // Following the link proved they read that inbox.
        if (!user.verifiedAt)
          await d.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, userId));
        if (sessionHash)
          await d
            .update(sessions)
            .set({ organizationId: invite.organizationId })
            .where(and(eq(sessions.tokenHash, sessionHash), eq(sessions.userId, userId)));
        return {
          organization: { ...organization },
          role: membership!.role,
          joined: inserted.length > 0,
        };
      },
      tenantSettings(context),
      { name: "invite.accept" },
    );
    if (sessionHash) forgetCachedSession(sessionHash);
    return result;
  }

  // ------------------------------------------------------------ one organization

  /** The organization's row, if it's live. */
  async get(context: TenantContext) {
    const rows = await this.db.one(
      (d) =>
        d
          .select({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
            createdAt: organizations.createdAt,
          })
          .from(organizations)
          .where(and(eq(organizations.id, context.organizationId), isNull(organizations.deletedAt)))
          .limit(1),
      tenantSettings(context),
      { name: "organization.get" },
    );
    if (!rows[0]) throw notAMember();
    return rows[0];
  }

  /** The caller's role, read now (not from a cached session): null when they're not a member. */
  async roleOf(context: TenantContext): Promise<Role | null> {
    const rows = await this.db.one(
      (d) =>
        d
          .select({ role: memberships.role })
          .from(memberships)
          .innerJoin(
            organizations,
            and(eq(organizations.id, memberships.organizationId), isNull(organizations.deletedAt)),
          )
          .where(
            and(
              eq(memberships.organizationId, context.organizationId),
              eq(memberships.userId, context.userId),
            ),
          )
          .limit(1),
      tenantSettings(context),
      { name: "membership.role" },
    );
    return rows[0]?.role ?? null;
  }

  /** Name and slug. */
  async update(
    context: TenantContext,
    input: { name?: string; slug?: string },
  ): Promise<{ id: string; name: string; slug: string | null; createdAt: Date }> {
    const changes: Partial<typeof organizations.$inferInsert> = { updatedAt: this.now() };
    if (input.name !== undefined) changes.name = input.name;
    if (input.slug !== undefined) changes.slug = input.slug;
    try {
      const rows = await this.db.one(
        (d) =>
          d
            .update(organizations)
            .set(changes)
            .where(
              and(eq(organizations.id, context.organizationId), isNull(organizations.deletedAt)),
            )
            .returning({
              id: organizations.id,
              name: organizations.name,
              slug: organizations.slug,
              createdAt: organizations.createdAt,
            }),
        tenantSettings(context),
        { name: "organization.update" },
      );
      if (!rows[0]) throw notAMember();
      return rows[0];
    } catch (error) {
      if (sqlState(error) === "23505" && violatedConstraint(error) === "organizations_slug")
        throw new ActionError("conflict", "That slug is taken.", { slug: "That slug is taken." });
      throw error;
    }
  }

  private memberQuery(d: Drizzle, context: TenantContext, userIds?: string[]) {
    return d
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        title: users.title,
        avatarUrl: users.avatarUrl,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          isNull(users.deletedAt),
          ...(userIds ? [inArray(memberships.userId, userIds)] : []),
        ),
      );
  }

  private toMember(
    context: TenantContext,
    row: {
      userId: string;
      name: string;
      email: string;
      title: string | null;
      avatarUrl: string | null;
      role: Role;
      joinedAt: Date;
    },
  ): Member {
    return { ...row, joinedAt: row.joinedAt.toISOString(), you: row.userId === context.userId };
  }

  /** Everyone in the organization: owners, then admins, then members. */
  async members(context: TenantContext): Promise<Member[]> {
    const rows = await this.db.one((d) => this.memberQuery(d, context), tenantSettings(context), {
      name: "members.list",
    });
    return rows.map((row) => this.toMember(context, row)).sort(byRoleThenName);
  }

  /**
   * Runs a membership change with the organization's row locked and every membership read
   * inside the same transaction, so the caller's role is current and two owners demoting each
   * other at once can't both succeed. A last-owner violation the checks missed is caught by the
   * deferred trigger at commit.
   */
  private async locked<T>(
    context: TenantContext,
    name: string,
    work: (d: Drizzle, state: Locked) => Promise<T>,
  ): Promise<T> {
    let organizationName = "This company";
    try {
      return await this.db.transaction(
        async (d) => {
          const [organization] = await d
            .select({ id: organizations.id, name: organizations.name })
            .from(organizations)
            .where(
              and(eq(organizations.id, context.organizationId), isNull(organizations.deletedAt)),
            )
            .limit(1)
            .for("update");
          if (!organization) throw notAMember();
          organizationName = organization.name;
          const members = await d
            .select({ userId: memberships.userId, role: memberships.role })
            .from(memberships)
            .where(eq(memberships.organizationId, context.organizationId));
          const actor = members.find((m) => m.userId === context.userId);
          if (!actor) throw notAMember();
          return work(d, { organization, members, actor });
        },
        tenantSettings(context),
        { name },
      );
    } catch (error) {
      if (isLastOwnerViolation(error)) throw lastOwnerError(organizationName);
      throw error;
    }
  }

  /** Throws `forbidden` unless the role, read in this transaction, holds the permission. */
  private static require(state: Locked, permission: Permission, message: string): void {
    if (!roleCan(state.actor.role, permission)) throw new ActionError("forbidden", message);
  }

  private static owners(state: Locked): number {
    return state.members.filter((m) => isOwnerRole(m.role)).length;
  }

  /** Changes someone's role, under `mayChangeMember` and the last-owner rule. */
  async changeRole(
    context: TenantContext,
    targetUserId: string,
    newRole: Role,
  ): Promise<{ member: Member; previousRole: Role }> {
    return this.locked(context, "members.updateRole", async (d, state) => {
      const target = state.members.find((m) => m.userId === targetUserId);
      if (!target)
        throw new ActionError("not_found", "That person isn't a member of this company.");
      const problem = mayChangeMember({ actor: state.actor, target, newRole });
      if (problem) throw new ActionError("forbidden", problem);
      if (isOwnerRole(target.role) && !isOwnerRole(newRole) && Organizations.owners(state) <= 1)
        throw lastOwnerError(state.organization.name);
      if (target.role !== newRole)
        await d
          .update(memberships)
          .set({ role: newRole, updatedAt: this.now() })
          .where(
            and(
              eq(memberships.organizationId, context.organizationId),
              eq(memberships.userId, targetUserId),
            ),
          );
      const [row] = await this.memberQuery(d, context, [targetUserId]);
      return { member: this.toMember(context, row!), previousRole: target.role };
    });
  }

  /**
   * Removes someone. Their sessions that have this organization open end in the same
   * transaction; the caller revokes their connected apps for it.
   */
  async removeMember(context: TenantContext, targetUserId: string): Promise<Member> {
    return this.locked(context, "members.remove", async (d, state) => {
      if (targetUserId === context.userId)
        throw new ActionError("invalid_input", "To leave this company, use Leave company.");
      const target = state.members.find((m) => m.userId === targetUserId);
      if (!target)
        throw new ActionError("not_found", "That person isn't a member of this company.");
      const problem = mayChangeMember({ actor: state.actor, target, newRole: null });
      if (problem) throw new ActionError("forbidden", problem);
      if (isOwnerRole(target.role) && Organizations.owners(state) <= 1)
        throw lastOwnerError(state.organization.name);
      const [row] = await this.memberQuery(d, context, [targetUserId]);
      await d
        .delete(memberships)
        .where(
          and(
            eq(memberships.organizationId, context.organizationId),
            eq(memberships.userId, targetUserId),
          ),
        );
      await this.sessions.endInOrganizationStatement(d, targetUserId, context.organizationId);
      return this.toMember(context, row!);
    });
  }

  /**
   * Leaves the organization. The person's sessions that had it open re-open their most recently
   * used other one on their next request (or none: `/onboarding`), which this returns.
   */
  async leave(context: TenantContext): Promise<OrganizationRef | null> {
    const next = await this.locked(context, "organization.leave", async (d, state) => {
      if (isOwnerRole(state.actor.role) && Organizations.owners(state) <= 1)
        throw state.members.length === 1
          ? new ActionError(
              "conflict",
              `You're the only member of ${state.organization.name}. Delete the company instead of leaving it.`,
            )
          : lastOwnerError(state.organization.name);
      await d
        .delete(memberships)
        .where(
          and(
            eq(memberships.organizationId, context.organizationId),
            eq(memberships.userId, context.userId),
          ),
        );
      await d
        .update(sessions)
        .set({ organizationId: null })
        .where(
          and(
            eq(sessions.userId, context.userId),
            eq(sessions.organizationId, context.organizationId),
          ),
        );
      const own = await ownOrganizations(d).execute();
      const after = own.find((o) => o.id !== context.organizationId) ?? null;
      return after ? { id: after.id, name: after.name, slug: after.slug } : null;
    });
    forgetCachedSessionsFor(context.userId);
    return next;
  }

  /** The chosen member becomes an owner and the caller an admin, in one transaction. */
  async transferOwnership(
    context: TenantContext,
    targetUserId: string,
  ): Promise<{ members: Member[]; organizationName: string }> {
    return this.locked(context, "organization.transferOwnership", async (d, state) => {
      Organizations.require(state, "organization.transfer", "Only owners can transfer ownership.");
      if (targetUserId === context.userId)
        throw new ActionError("invalid_input", "Pick someone else to make the owner.");
      const target = state.members.find((m) => m.userId === targetUserId);
      if (!target)
        throw new ActionError("not_found", "That person isn't a member of this company.");
      const now = this.now();
      await d
        .update(memberships)
        .set({ role: "owner", updatedAt: now })
        .where(
          and(
            eq(memberships.organizationId, context.organizationId),
            eq(memberships.userId, targetUserId),
          ),
        );
      await d
        .update(memberships)
        .set({ role: "admin", updatedAt: now })
        .where(
          and(
            eq(memberships.organizationId, context.organizationId),
            eq(memberships.userId, context.userId),
          ),
        );
      const rows = await this.memberQuery(d, context);
      return {
        members: rows.map((row) => this.toMember(context, row)).sort(byRoleThenName),
        organizationName: state.organization.name,
      };
    });
  }

  /**
   * Deletes the organization (soft). Every member loses access at once: profiles stop resolving
   * for a deleted organization, and sessions that had it open re-open another one. Returns the
   * members, whose connected apps the caller revokes. `restore` undoes it within
   * `DELETED_ORGANIZATION_RETENTION_MS`; `purgeDeleted` then removes it for good.
   */
  async softDelete(
    context: TenantContext,
    confirmName: string,
  ): Promise<{ memberIds: string[]; name: string; next: OrganizationRef | null }> {
    const result = await this.locked(context, "organization.delete", async (d, state) => {
      Organizations.require(state, "organization.delete", "Only owners can delete the company.");
      if (confirmName.trim().toLowerCase() !== state.organization.name.trim().toLowerCase())
        throw new ActionError("invalid_input", "That isn't the company's name.", {
          confirmName: `Type ${state.organization.name} exactly.`,
        });
      const now = this.now();
      await d
        .update(organizations)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(organizations.id, context.organizationId));
      await d
        .update(sessions)
        .set({ organizationId: null })
        .where(eq(sessions.organizationId, context.organizationId));
      const own = await ownOrganizations(d).execute();
      const after = own.find((o) => o.id !== context.organizationId) ?? null;
      return {
        memberIds: state.members.map((m) => m.userId),
        name: state.organization.name,
        next: after ? { id: after.id, name: after.name, slug: after.slug } : null,
      };
    });
    for (const userId of result.memberIds) forgetCachedSessionsFor(userId);
    return result;
  }

  /** Operators only (`pnpm org:restore <id>`): un-deletes within the restore window. */
  async restore(organizationId: string): Promise<boolean> {
    const rows = await this.db.one(
      (d) =>
        d
          .update(organizations)
          .set({ deletedAt: null, updatedAt: this.now() })
          .where(and(eq(organizations.id, organizationId), isNotNull(organizations.deletedAt)))
          .returning({ id: organizations.id }),
      { "app.organization_id": organizationId, "app.user_id": "" },
      { name: "organization.restore" },
    );
    return rows.length > 0;
  }

  // ------------------------------------------------------------ invitations, sending

  private inviteQuery(d: Drizzle, context: TenantContext) {
    return d
      .select({
        invite: organizationInvites,
        inviterName: users.name,
      })
      .from(organizationInvites)
      .leftJoin(users, eq(users.id, organizationInvites.invitedByUserId))
      .where(
        and(
          eq(organizationInvites.organizationId, context.organizationId),
          isNull(organizationInvites.acceptedAt),
        ),
      );
  }

  /** Pending and expired invitations, newest first. */
  async invites(context: TenantContext): Promise<Invite[]> {
    const rows = await this.db.one(
      (d) => this.inviteQuery(d, context).orderBy(desc(organizationInvites.createdAt)),
      tenantSettings(context),
      { name: "invites.list" },
    );
    const now = this.clock();
    return rows.map((row) => toInvite({ ...row.invite, inviterName: row.inviterName }, now));
  }

  /**
   * Creates an invitation, or sends a pending one to the same address again (a new link). The
   * token comes back once, for the email; only its HMAC is stored. Refuses someone who's
   * already a member, more than `INVITES_PER_DAY`, and a resend within a minute.
   */
  async createInvite(
    context: TenantContext,
    input: { email: string; role: InviteRole },
  ): Promise<{ invite: Invite; token: string; resent: boolean }> {
    const token = randomToken();
    const tokenHash = await hashToken(token, this.pepper);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const { row, resent } = await this.db.transaction(
      async (d) => {
        const [member] = await d
          .select({ id: users.id })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.organizationId, context.organizationId),
              eq(users.email, input.email),
              isNull(users.deletedAt),
            ),
          )
          .limit(1);
        if (member)
          throw new ActionError("conflict", `${input.email} is already a member.`, {
            email: "They're already a member.",
          });
        const [pending] = await d
          .select()
          .from(organizationInvites)
          .where(
            and(
              eq(organizationInvites.organizationId, context.organizationId),
              eq(organizationInvites.email, input.email),
              isNull(organizationInvites.acceptedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (pending) {
          if (now.getTime() - pending.lastSentAt.getTime() < INVITE_RESEND_MS)
            throw new ActionError(
              "rate_limited",
              "You sent this invitation a moment ago. Wait a minute before sending it again.",
            );
          const [updated] = await d
            .update(organizationInvites)
            .set({
              role: input.role,
              tokenHash,
              expiresAt,
              lastSentAt: now,
              sendCount: pending.sendCount + 1,
              invitedByUserId: context.userId,
            })
            .where(
              and(
                eq(organizationInvites.organizationId, context.organizationId),
                eq(organizationInvites.id, pending.id),
              ),
            )
            .returning();
          return { row: updated!, resent: true };
        }
        // One at a time: an interactive transaction is one connection.
        const sentToday = await d
          .select({ n: count() })
          .from(organizationInvites)
          .where(
            and(
              eq(organizationInvites.organizationId, context.organizationId),
              gt(organizationInvites.lastSentAt, new Date(now.getTime() - DAY_MS)),
            ),
          );
        const sentByYou = await d
          .select({ n: count() })
          .from(organizationInvites)
          .where(
            and(
              eq(organizationInvites.organizationId, context.organizationId),
              eq(organizationInvites.invitedByUserId, context.userId),
              gt(organizationInvites.lastSentAt, new Date(now.getTime() - MINUTE_MS)),
            ),
          );
        if ((sentToday[0]?.n ?? 0) >= INVITES_PER_DAY)
          throw new ActionError(
            "rate_limited",
            `This company has sent ${INVITES_PER_DAY} invitations today. Try again tomorrow.`,
          );
        if ((sentByYou[0]?.n ?? 0) >= INVITES_PER_MINUTE)
          throw new ActionError(
            "rate_limited",
            "You've sent a lot of invitations just now. Wait a minute and try again.",
          );
        const [created] = await d
          .insert(organizationInvites)
          .values({
            organizationId: context.organizationId,
            id: uuidv7(),
            email: input.email,
            role: input.role,
            tokenHash,
            invitedByUserId: context.userId,
            expiresAt,
            lastSentAt: now,
          })
          .returning();
        return { row: created!, resent: false };
      },
      tenantSettings(context),
      { name: "invites.create" },
    );
    const inviterName = await this.nameOf(context.userId);
    return { invite: toInvite({ ...row, inviterName }, this.clock()), token, resent };
  }

  /** A new link for a pending (or expired) invitation: the old one stops working. */
  async resendInvite(
    context: TenantContext,
    inviteId: string,
  ): Promise<{ invite: Invite; token: string }> {
    const token = randomToken();
    const tokenHash = await hashToken(token, this.pepper);
    const now = this.now();
    const row = await this.db.transaction(
      async (d) => {
        const [pending] = await d
          .select()
          .from(organizationInvites)
          .where(
            and(
              eq(organizationInvites.organizationId, context.organizationId),
              eq(organizationInvites.id, inviteId),
              isNull(organizationInvites.acceptedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!pending) throw new ActionError("not_found", "That invitation is gone.");
        if (now.getTime() - pending.lastSentAt.getTime() < INVITE_RESEND_MS)
          throw new ActionError(
            "rate_limited",
            "You sent this invitation a moment ago. Wait a minute before sending it again.",
          );
        const [updated] = await d
          .update(organizationInvites)
          .set({
            tokenHash,
            expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
            lastSentAt: now,
            sendCount: pending.sendCount + 1,
          })
          .where(
            and(
              eq(organizationInvites.organizationId, context.organizationId),
              eq(organizationInvites.id, inviteId),
            ),
          )
          .returning();
        return updated!;
      },
      tenantSettings(context),
      { name: "invites.resend" },
    );
    const inviterName = row.invitedByUserId ? await this.nameOf(row.invitedByUserId) : null;
    return { invite: toInvite({ ...row, inviterName }, this.clock()), token };
  }

  /** Deletes a pending invitation; its link stops working. */
  async revokeInvite(context: TenantContext, inviteId: string): Promise<void> {
    const rows = await this.db.one(
      (d) =>
        d
          .delete(organizationInvites)
          .where(
            and(
              eq(organizationInvites.organizationId, context.organizationId),
              eq(organizationInvites.id, inviteId),
              isNull(organizationInvites.acceptedAt),
            ),
          )
          .returning({ id: organizationInvites.id }),
      tenantSettings(context),
      { name: "invites.revoke" },
    );
    if (!rows.length) throw new ActionError("not_found", "That invitation is already gone.");
  }

  private async nameOf(userId: string): Promise<string | null> {
    const rows = await this.db.one((d) =>
      d.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1),
    );
    return rows[0]?.name ?? null;
  }

  // ------------------------------------------------------------ account deletion and cleanup

  /**
   * The companies the person owns alone: `blockers` have other members (deleting the account is
   * refused until someone else is an owner), `alone` has nobody else (deleted with the account).
   */
  async soleOwnerships(userId: string): Promise<{
    blockers: OrganizationSummary[];
    alone: OrganizationSummary[];
  }> {
    const owned = (await this.list(userId)).filter((o) => isOwnerRole(o.role));
    if (!owned.length) return { blockers: [], alone: [] };
    const counts = await this.db.batch((d) =>
      owned.flatMap((organization) => [
        setContext(d, { organizationId: organization.id, userId }),
        d
          .select({ role: memberships.role, n: count() })
          .from(memberships)
          .where(eq(memberships.organizationId, organization.id))
          .groupBy(memberships.role),
      ]),
    );
    const blockers: OrganizationSummary[] = [];
    const alone: OrganizationSummary[] = [];
    owned.forEach((organization, i) => {
      const rows = counts[i * 2 + 1] as { role: Role; n: number }[];
      const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
      const owners = rows.filter((r) => isOwnerRole(r.role)).reduce((s, r) => s + Number(r.n), 0);
      if (total <= 1) alone.push(organization);
      else if (owners <= 1) blockers.push(organization);
    });
    return { blockers, alone };
  }

  /**
   * The cleanup cron: removes organizations deleted more than `DELETED_ORGANIZATION_RETENTION_MS`
   * ago. `beforeRemove` runs first for each (their Durable Objects' storage goes first); then the
   * row goes, and every tenant table's rows with it (`ON DELETE CASCADE`). Returns the ids.
   */
  async purgeDeleted(
    limit = 50,
    options: { beforeRemove?: (organizationId: string) => Promise<void> } = {},
  ): Promise<string[]> {
    const cutoff = new Date(this.clock() - DELETED_ORGANIZATION_RETENTION_MS);
    const due = await this.db.one(
      (d) =>
        d
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(isNotNull(organizations.deletedAt), lt(organizations.deletedAt, cutoff)))
          .limit(limit),
      {
        "app.organization_id": NO_ORGANIZATION,
        "app.user_id": "",
        "app.job": "organization-cleanup",
      },
      { name: "organizations.purge.find" },
    );
    const removed: string[] = [];
    for (const { id } of due) {
      await options.beforeRemove?.(id);
      await this.db.one(
        (d) => d.delete(organizations).where(eq(organizations.id, id)),
        { "app.organization_id": id, "app.user_id": "" },
        { name: "organizations.purge" },
      );
      removed.push(id);
    }
    return removed;
  }

  /** The cleanup cron: accepted and expired invitations older than `INVITE_RETENTION_MS`. */
  async purgeInvites(limit = 500): Promise<number> {
    const cutoff = new Date(this.clock() - INVITE_RETENTION_MS);
    const due = await this.db.one(
      (d) =>
        d
          .select({
            organizationId: organizationInvites.organizationId,
            id: organizationInvites.id,
          })
          .from(organizationInvites)
          .where(
            or(
              lt(organizationInvites.expiresAt, cutoff),
              lt(organizationInvites.acceptedAt, cutoff),
            ),
          )
          .limit(limit),
      {
        "app.organization_id": NO_ORGANIZATION,
        "app.user_id": "",
        "app.job": "organization-cleanup",
      },
      { name: "invites.purge.find" },
    );
    if (!due.length) return 0;
    const byOrganization = new Map<string, string[]>();
    for (const row of due)
      byOrganization.set(row.organizationId, [
        ...(byOrganization.get(row.organizationId) ?? []),
        row.id,
      ]);
    await this.db.batch(
      (d) =>
        [...byOrganization].flatMap(([organizationId, ids]) => [
          setContext(d, { organizationId }),
          d
            .delete(organizationInvites)
            .where(
              and(
                eq(organizationInvites.organizationId, organizationId),
                inArray(organizationInvites.id, ids),
              ),
            ),
        ]),
      undefined,
      { name: "invites.purge" },
    );
    return due.length;
  }

  /** Every member's id (for the deletion's grant revocation and Durable Object cleanup). */
  async memberIds(context: TenantContext): Promise<string[]> {
    const rows = await this.db.one(
      (d) =>
        d
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(eq(memberships.organizationId, context.organizationId)),
      tenantSettings(context),
      { name: "members.ids" },
    );
    return rows.map((r) => r.userId);
  }
}
