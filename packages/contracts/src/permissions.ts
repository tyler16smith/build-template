import type { Role } from "./schemas";

/**
 * Who may do what (`specs/organizations.md`, "Permissions"). Code asks for a named permission
 * (`requirePermission(ctx, "members.manage")`, `useCan("members.manage")`), never for a role:
 * which roles hold a permission is decided here, once. This is the only file that compares
 * roles (`pnpm check:permissions`).
 *
 * A module adds its permissions to `PERMISSIONS` and to the roles that get them, in the same
 * pull request. Owners hold every permission, and every permission belongs to some role (a test
 * checks both).
 */
export const PERMISSIONS = {
  "organization.manage": "Rename the company and change its slug",
  "organization.delete": "Delete the company",
  "organization.transfer": "Make someone an owner, transfer ownership",
  "members.manage": "Invite people, resend and revoke invites, change roles, remove members",
  "billing.manage": "Reserved for billing",
  "automations.manage": "Build automations and Zapier connections, and see their run data",
  "ai.manage": "Change the Assistant's default model, monthly budget and daily cap",
  "ai.usage": "See the Assistant's spending and limits",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const rolePermissions = {
  owner: [
    "organization.manage",
    "organization.delete",
    "organization.transfer",
    "members.manage",
    "billing.manage",
    "automations.manage",
    "ai.manage",
    "ai.usage",
  ],
  admin: ["organization.manage", "members.manage", "automations.manage", "ai.usage"],
  member: [],
} as const satisfies Record<Role, readonly Permission[]>;

/** Permissions whose actions re-read the caller's role in their own transaction. */
export function needsFreshRole(permission: Permission): boolean {
  return (
    permission === "members.manage" ||
    permission.startsWith("organization.") ||
    permission.startsWith("billing.")
  );
}

/** Whether a role holds a permission. */
export function roleCan(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (rolePermissions[role] as readonly Permission[]).includes(permission);
}

/** Every permission a role holds, for `GET /api/session` and `organization.get`. */
export function permissionsOf(role: Role | null | undefined): Permission[] {
  return role ? [...rolePermissions[role]] : [];
}

/** Whether a role may run an action: anyone when it names no permission. */
export function mayRun(
  action: { permission?: Permission | undefined },
  role: Role | null | undefined,
): boolean {
  if (!role) return false;
  return !action.permission || roleCan(role, action.permission);
}

/** The roles an invitation can grant. Ownership is given to someone already in the company. */
export const INVITE_ROLES = ["admin", "member"] as const satisfies readonly Role[];
export type InviteRole = (typeof INVITE_ROLES)[number];

/** Whether the role is an owner: the last-owner rule counts these. */
export function isOwnerRole(role: Role | null | undefined): boolean {
  return role === "owner";
}

/** Highest first: lowering your own role means moving down this list. */
export const ROLE_ORDER = ["owner", "admin", "member"] as const satisfies readonly Role[];
const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

/** The roles `actor` may invite people as. */
export function invitableRoles(actor: Role): InviteRole[] {
  if (!roleCan(actor, "members.manage")) return [];
  return INVITE_ROLES.filter((role) => RANK[role] <= RANK[actor]);
}

export type MemberChange = {
  actor: { userId: string; role: Role };
  target: { userId: string; role: Role };
  /** The role to give; null removes the member (or, for yourself, leaves). */
  newRole: Role | null;
};

/**
 * Who can change whom (`specs/organizations.md`, "Who can change whom"). Returns null when the
 * change is allowed, else a sentence for the person. The last-owner rule is separate: it needs
 * the count of owners, so it's checked where the change is written.
 *
 * - Owners can change or remove anyone; granting `owner` needs `organization.transfer`.
 * - Admins can promote a member to admin and remove members. They can't change or remove another
 *   admin or an owner, and can't grant `owner`.
 * - Anyone can lower their own role or leave.
 */
export function mayChangeMember({ actor, target, newRole }: MemberChange): string | null {
  const self = actor.userId === target.userId;
  if (self) {
    if (newRole === null) return null;
    if (RANK[newRole] <= RANK[target.role]) return null;
    return "You can't raise your own role. Ask an owner.";
  }
  if (!roleCan(actor.role, "members.manage"))
    return "Only owners and admins can change other people's roles.";
  if (newRole && isOwnerRole(newRole) && !roleCan(actor.role, "organization.transfer"))
    return "Only owners can make someone an owner.";
  if (roleCan(actor.role, "organization.transfer")) return null;
  if (RANK[target.role] >= RANK[actor.role])
    return newRole === null
      ? `You can't remove ${target.role === "owner" ? "an owner" : "another admin"}. Ask an owner.`
      : `You can't change ${target.role === "owner" ? "an owner's" : "another admin's"} role. Ask an owner.`;
  if (newRole && RANK[newRole] > RANK[actor.role])
    return "You can't give someone a higher role than your own.";
  return null;
}

/** The roles `actor` may set on `target`, for the role picker. */
export function assignableRoles(
  actor: { userId: string; role: Role },
  target: {
    userId: string;
    role: Role;
  },
): Role[] {
  return ROLE_ORDER.filter(
    (newRole) => newRole === target.role || !mayChangeMember({ actor, target, newRole }),
  );
}
