import {
  ActionError,
  needsFreshRole,
  roleCan,
  type Permission,
  type Role,
} from "@template/contracts";
import type { ActionContext } from "./define";

/**
 * What a refusal says, per permission: written for the person, shown as it is in the app and in
 * MCP results.
 */
const REFUSALS: Record<Permission, string> = {
  "organization.manage": "Only owners and admins can change the company's details.",
  "organization.delete": "Only owners can delete the company.",
  "organization.transfer": "Only owners can make someone an owner.",
  "members.manage": "Only owners and admins can invite people or change members.",
  "billing.manage": "Only owners can change billing.",
  "automations.manage":
    "Only owners and admins can change automations. Ask one of them to do this.",
  "ai.manage": "Only owners can change AI settings.",
  "ai.usage": "Only owners and admins can see AI spending.",
};

export function refusal(permission: Permission): string {
  return REFUSALS[permission];
}

/** Anything acting in an organization: an action's `ctx`, or an automation's principal. */
type Subject = Pick<ActionContext, "membership"> | { role: Role };

function roleOf(subject: Subject): Role {
  return "membership" in subject ? subject.membership.role : subject.role;
}

/** Whether the subject's role holds the permission. */
export function can(subject: Subject, permission: Permission): boolean {
  return roleCan(roleOf(subject), permission);
}

/**
 * Throws `forbidden` unless the caller may. Never compare roles: ask for a permission.
 *
 * `{ fresh: true }` re-reads the role from the database instead of trusting the session's (or MCP
 * membership cache's) copy, which can be up to a minute old. Actions that change members,
 * ownership, the organization or billing use it, so a demoted admin can't act in that minute;
 * the write itself re-checks inside its transaction too.
 */
export function requirePermission(subject: Subject, permission: Permission): void;
export function requirePermission(
  subject: ActionContext,
  permission: Permission,
  options: { fresh: true },
): Promise<void>;
export function requirePermission(
  subject: Subject,
  permission: Permission,
  options?: { fresh: true },
): void | Promise<void> {
  if (!options?.fresh) {
    if (!can(subject, permission)) throw new ActionError("forbidden", refusal(permission));
    return;
  }
  const ctx = subject as ActionContext;
  return ctx.organizations.roleOf().then((role) => {
    if (!role) throw new ActionError("not_a_member", "You're no longer a member of this company.");
    if (!roleCan(role, permission)) throw new ActionError("forbidden", refusal(permission));
  });
}

/** `requirePermission`, fresh when the permission calls for it (`needsFreshRole`). */
export async function requireActionPermission(
  ctx: ActionContext,
  permission: Permission,
): Promise<void> {
  if (needsFreshRole(permission)) await requirePermission(ctx, permission, { fresh: true });
  else requirePermission(ctx, permission);
}
