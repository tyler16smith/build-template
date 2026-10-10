import type { Role } from "@template/contracts";

/** How screens name roles. Looked up, never compared (`pnpm check:permissions`). */
export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** "an admin", "a member": for sentences. */
export const ROLE_IN_A_SENTENCE: Record<Role, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
};
