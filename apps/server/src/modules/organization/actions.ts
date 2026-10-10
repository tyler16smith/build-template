import {
  ActionError,
  invitableRoles,
  invitesCreate,
  invitesList,
  invitesResend,
  invitesRevoke,
  membersList,
  membersRemove,
  membersUpdateRole,
  organizationDelete,
  organizationGet,
  organizationLeave,
  organizationTransferOwnership,
  organizationUpdate,
  permissionsOf,
  type Invite,
  type OrganizationView,
} from "@template/contracts";
import { automations, eq, zapierConnections } from "@template/db";
import { defineAction, type ActionContext } from "../../actions/define";
import * as emails from "../../lib/emails";

/**
 * The organization layer's actions (`specs/organizations.md`, "Actions"). None takes an
 * organization id: every one acts on `ctx.organization`. Permissions are checked by the registry
 * (fresh, for members and the organization itself) and again inside the transaction that writes.
 */

function view(
  ctx: ActionContext,
  row: { id: string; name: string; slug: string | null; createdAt: Date },
): OrganizationView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: ctx.membership.role,
    permissions: permissionsOf(ctx.membership.role),
    createdAt: row.createdAt.toISOString(),
  };
}

export const getOrganization = defineAction({
  ...organizationGet,
  handler: async (ctx) => view(ctx, await ctx.organizations.get()),
});

export const updateOrganization = defineAction({
  ...organizationUpdate,
  handler: async (ctx, input) => {
    const row = await ctx.organizations.update(input);
    ctx.log.info("organization.updated", { changed: Object.keys(input) });
    return view(ctx, row);
  },
});

export const transferOwnership = defineAction({
  ...organizationTransferOwnership,
  handler: async (ctx, input) => {
    const { members, organizationName } = await ctx.organizations.transferOwnership(input.userId);
    const newOwner = members.find((m) => m.userId === input.userId);
    const previousOwner = members.find((m) => m.userId === ctx.user.id);
    ctx.log.info("organization.ownership_transferred", { toUserId: input.userId });
    if (newOwner && previousOwner)
      for (const [person, youAreNewOwner] of [
        [newOwner, true],
        [previousOwner, false],
      ] as const)
        await ctx.sendMail(
          emails.ownershipTransferred(ctx.app.name, person.email, {
            organization: organizationName,
            newOwner: newOwner.name,
            previousOwner: previousOwner.name,
            youAreNewOwner,
          }),
        );
    return { members };
  },
});

export const leaveOrganization = defineAction({
  ...organizationLeave,
  handler: async (ctx) => {
    const next = await ctx.organizations.leave();
    await ctx.revokeConnections(ctx.user.id);
    ctx.log.info("organization.left");
    return { ok: true as const, next };
  },
});

/**
 * Soft-deletes the organization: every member loses access at once, their connected apps for it
 * are revoked, Zapier connections are turned off and automations stop. Restorable for 30 days
 * (`pnpm org:restore <id>`); the cleanup cron then removes it and everything in it.
 */
export const deleteOrganization = defineAction({
  ...organizationDelete,
  handler: async (ctx, input) => {
    const { memberIds, next } = await ctx.organizations.softDelete(input.confirmName);
    // Stop what runs on its own. (Runs already check membership, which a deleted company fails.)
    await ctx.db.batch((q) => [
      q.update(
        automations,
        { status: "paused", statusReason: "The company was deleted.", updatedAt: new Date() },
        eq(automations.status, "active"),
      ),
      q.update(zapierConnections, { status: "disabled", updatedAt: new Date() }),
    ]);
    for (const userId of memberIds) await ctx.revokeConnections(userId);
    ctx.log.info("organization.deleted", { members: memberIds.length });
    return { ok: true as const, next };
  },
});

export const listMembers = defineAction({
  ...membersList,
  handler: async (ctx) => ({ members: await ctx.organizations.members() }),
});

export const updateMemberRole = defineAction({
  ...membersUpdateRole,
  handler: async (ctx, input) => {
    const { member, previousRole } = await ctx.organizations.changeRole(input.userId, input.role);
    if (previousRole !== member.role)
      ctx.log.info("members.role_changed", {
        targetUserId: member.userId,
        from: previousRole,
        to: member.role,
      });
    return member;
  },
});

export const removeMember = defineAction({
  ...membersRemove,
  handler: async (ctx, input) => {
    const member = await ctx.organizations.removeMember(input.userId);
    await ctx.revokeConnections(member.userId);
    ctx.log.info("members.removed", { targetUserId: member.userId });
    return member;
  },
});

export const listInvites = defineAction({
  ...invitesList,
  handler: async (ctx) => ({ invites: await ctx.organizations.invites() }),
});

async function sendInvitation(ctx: ActionContext, invite: Invite, token: string): Promise<void> {
  await ctx.sendMail(
    emails.invitation(ctx.app.name, invite.email, {
      organization: ctx.organization.name,
      inviter: invite.invitedBy.name ?? "Someone",
      role: invite.role,
      origin: ctx.app.origin,
      token,
      expiresAt: new Date(invite.expiresAt),
    }),
  );
}

export const createInvite = defineAction({
  ...invitesCreate,
  handler: async (ctx, input) => {
    if (!invitableRoles(ctx.membership.role).includes(input.role))
      throw new ActionError("forbidden", `You can't invite someone as ${input.role}.`, {
        role: "Pick a role you can give.",
      });
    const { invite, token, resent } = await ctx.organizations.createInvite(input);
    await sendInvitation(ctx, invite, token);
    ctx.log.info("invite.sent", { inviteId: invite.id, resent, role: invite.role });
    return { ...invite, resent };
  },
});

export const resendInvite = defineAction({
  ...invitesResend,
  handler: async (ctx, input) => {
    const { invite, token } = await ctx.organizations.resendInvite(input.inviteId);
    await sendInvitation(ctx, invite, token);
    ctx.log.info("invite.sent", { inviteId: invite.id, resent: true });
    return invite;
  },
});

export const revokeInvite = defineAction({
  ...invitesRevoke,
  handler: async (ctx, input) => {
    await ctx.organizations.revokeInvite(input.inviteId);
    ctx.log.info("invite.revoked", { inviteId: input.inviteId });
    return { ok: true as const };
  },
});

/** Registered in `actions/registry.ts`. */
export const ORGANIZATION_ACTIONS = {
  [getOrganization.id]: getOrganization,
  [updateOrganization.id]: updateOrganization,
  [transferOwnership.id]: transferOwnership,
  [leaveOrganization.id]: leaveOrganization,
  [deleteOrganization.id]: deleteOrganization,
  [listMembers.id]: listMembers,
  [updateMemberRole.id]: updateMemberRole,
  [removeMember.id]: removeMember,
  [listInvites.id]: listInvites,
  [createInvite.id]: createInvite,
  [resendInvite.id]: resendInvite,
  [revokeInvite.id]: revokeInvite,
};
