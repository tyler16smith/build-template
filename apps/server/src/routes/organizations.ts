import {
  ActionError,
  ALL_SCOPES,
  InviteAcceptInput,
  JoinPendingInviteInput,
  OrganizationCreateInput,
  SwitchOrganizationInput,
  type InvitePreview,
  type OrganizationRef,
  type Role,
} from "@template/contracts";
import {
  checkOrigin,
  clientIp,
  rateLimit,
  requireSession,
  type RequestContext,
} from "../lib/context";
import { emitEvent } from "../modules/automations/dispatch";
import { sessionView } from "./api";
import { body, ctxOf, json, router } from "./http";

/**
 * Organization routes that aren't actions, because they work across or outside an organization
 * or change the session (`specs/organizations.md`): creating a company, switching, and
 * invitations before the person is in the company. Each answers with the new `/api/session`
 * payload, so the web app needs one round trip.
 */
export const organizationRoutes = router();

async function respondWithSession(ctx: RequestContext, cookies: string[]): Promise<Response> {
  const { view, cookies: renewed } = await sessionView(ctx);
  return json(view, [...cookies, ...renewed]);
}

/** `/onboarding` and the switcher's Create company: the person becomes its owner, and it opens. */
organizationRoutes.post("/organizations", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const cookies: string[] = [];
  const identity = await requireSession(ctx, cookies);
  await rateLimit(ctx, ctx.env.AUTH_LIMIT, `create-org:${identity.userId}`, "organization-create");
  const input = await body(c, OrganizationCreateInput);
  const organization = await ctx
    .accounts()
    .organizations.create(identity.userId, input, identity.tokenHash);
  ctx.identify({ userId: identity.userId, organizationId: organization.id });
  ctx.log.info("organization.created");
  return respondWithSession(ctx, cookies);
});

/** The switcher and `?org=` links: opens another of the person's organizations in this session. */
organizationRoutes.post("/auth/switch-organization", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const cookies: string[] = [];
  const identity = await requireSession(ctx, cookies);
  const input = await body(c, SwitchOrganizationInput);
  const opened = await ctx
    .accounts()
    .organizations.switch(identity.userId, identity.tokenHash, input.organizationId);
  ctx.identify({ userId: identity.userId, organizationId: opened.id });
  ctx.log.info("organization.switched", { from: identity.organizationId });
  return respondWithSession(ctx, cookies);
});

/** What `/invite/:token` shows before anyone signs in. Rate limited per IP. */
organizationRoutes.get("/invites/:token", async (c) => {
  const ctx = ctxOf(c);
  await rateLimit(ctx, ctx.env.AUTH_LIMIT, `invite:${clientIp(ctx.request)}`, "invite-lookup");
  const token = c.req.param("token");
  const invite =
    token.length <= 200 ? await ctx.accounts().organizations.previewInvite(token) : null;
  if (!invite) {
    ctx.log.info("invite.rejected", { reason: "expired" });
    throw new ActionError(
      "not_found",
      "This invitation has expired or was revoked. Ask whoever invited you to send a new one.",
    );
  }
  const preview: InvitePreview = {
    organization: { id: invite.organizationId, name: invite.organizationName },
    invitedBy: invite.invitedByName,
    role: invite.role,
    email: invite.email,
    expiresAt: invite.expiresAt.toISOString(),
  };
  return json(preview);
});

/** After joining: `members.joined` to the automations listening for it, as the new member. */
function announceJoin(
  ctx: RequestContext,
  userId: string,
  organization: OrganizationRef,
  role: Role,
): void {
  ctx.waitUntil(
    (async () => {
      const members = await ctx
        .accounts()
        .organizations.members({ organizationId: organization.id, userId });
      const member = members.find((m) => m.userId === userId);
      if (!member) return;
      await emitEvent(ctx, {
        eventId: "members.joined",
        data: member,
        caller: {
          userId,
          organizationId: organization.id,
          organization: { name: organization.name, slug: organization.slug },
          role,
          emailVerified: true,
          scopes: ALL_SCOPES,
          caller: "web",
        },
      });
    })(),
  );
}

async function accepting<T extends { organization: OrganizationRef; role: Role; joined: boolean }>(
  ctx: RequestContext,
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    const result = await work();
    ctx.identify({ userId, organizationId: result.organization.id });
    ctx.log.info("invite.accepted", { joined: result.joined });
    if (result.joined) announceJoin(ctx, userId, result.organization, result.role);
    return result;
  } catch (error) {
    if (error instanceof ActionError)
      ctx.log.info("invite.rejected", {
        reason:
          error.code === "forbidden"
            ? "email_mismatch"
            : error.code === "rate_limited"
              ? "rate_limited"
              : "expired",
      });
    throw error;
  }
}

/** Accepts the invitation in the link, as the signed-in person, and opens its organization. */
organizationRoutes.post("/invites/accept", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const cookies: string[] = [];
  const identity = await requireSession(ctx, cookies);
  try {
    await rateLimit(ctx, ctx.env.AUTH_LIMIT, `invite-accept:${identity.userId}`, "invite-accept");
  } catch (error) {
    ctx.log.info("invite.rejected", { reason: "rate_limited" });
    throw error;
  }
  const input = await body(c, InviteAcceptInput);
  await accepting(ctx, identity.userId, () =>
    ctx.accounts().organizations.acceptInvite(identity.userId, input.token, identity.tokenHash),
  );
  return respondWithSession(ctx, cookies);
});

/** `/onboarding`: invitations waiting for the person's verified email. */
organizationRoutes.get("/invites", async (c) => {
  const ctx = ctxOf(c);
  const cookies: string[] = [];
  const identity = await requireSession(ctx, cookies);
  const details = await ctx.accounts().sessions.detailsByHash(identity.tokenHash);
  if (!details?.profile.emailVerified) return json({ invites: [] }, cookies);
  const invites = await ctx
    .accounts()
    .organizations.pendingInvites(identity.userId, details.profile.email);
  return json({ invites }, cookies);
});

/** Joins one of those from `/onboarding`, without the link: the verified email is the proof. */
organizationRoutes.post("/invites/join", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const cookies: string[] = [];
  const identity = await requireSession(ctx, cookies);
  const input = await body(c, JoinPendingInviteInput);
  const details = await ctx.accounts().sessions.detailsByHash(identity.tokenHash);
  if (!details?.profile.emailVerified)
    throw new ActionError("email_unverified", "Verify your email first.");
  await accepting(ctx, identity.userId, () =>
    ctx
      .accounts()
      .organizations.joinPending(
        identity.userId,
        details.profile.email,
        input.inviteId,
        identity.tokenHash,
      ),
  );
  return respondWithSession(ctx, cookies);
});

/** The companies that stop the person deleting their account: they're the only owner there. */
organizationRoutes.get("/auth/deletion-blockers", async (c) => {
  const ctx = ctxOf(c);
  const cookies: string[] = [];
  const identity = await requireSession(ctx, cookies);
  const { blockers } = await ctx.accounts().organizations.soleOwnerships(identity.userId);
  return json(
    { organizations: blockers.map(({ id, name, slug }) => ({ id, name, slug })) },
    cookies,
  );
});
