import { z } from "zod";
import { ALL_PERMISSIONS, INVITE_ROLES, type Permission } from "./permissions";
import { ALL_SCOPES } from "./scopes";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./limits";

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "That email is too long.")
  .email("Enter a valid email address.");

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

const name = z.string().trim().min(1, "Enter your name.").max(100, "Use at most 100 characters.");
const title = z.string().trim().max(120, "Use at most 120 characters.");

export const Role = z.enum(["owner", "admin", "member"]);
export type Role = z.infer<typeof Role>;

export const SignInMethod = z.enum(["password", "google"]);
export type SignInMethod = z.infer<typeof SignInMethod>;

// ---------------------------------------------------------------- profile (the CRUD example)

/** An organization as people see it: its id never changes; its name and slug can. */
export const OrganizationRef = z.object({
  id: z.string(),
  name: z.string(),
  /** Null for a company created before slugs existed, until it's given one. */
  slug: z.string().nullable(),
});
export type OrganizationRef = z.infer<typeof OrganizationRef>;

export const Profile = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  email: z.string(),
  emailVerified: z.boolean(),
  avatarUrl: z.string().nullable(),
  /**
   * The open organization and the person's role in it. Null only in `GET /api/session`, for a
   * person who hasn't joined or created a company yet (`/onboarding`): actions always have one.
   */
  organization: OrganizationRef.nullable(),
  role: Role.nullable(),
});
export type Profile = z.infer<typeof Profile>;

/** A profile inside an organization the person belongs to: what actions and agents see. */
export type MemberProfile = Profile & { organization: OrganizationRef; role: Role };

export const ProfileGetInput = z.object({});
export type ProfileGetInput = z.infer<typeof ProfileGetInput>;

export const ProfileUpdateInput = z
  .object({
    name: name.optional(),
    /** An empty string clears the title. */
    title: title.optional(),
  })
  .refine((input) => input.name !== undefined || input.title !== undefined, {
    message: "Say what to change: name, title or both.",
  });
export type ProfileUpdateInput = z.infer<typeof ProfileUpdateInput>;

// ---------------------------------------------------------------- organizations

export const PermissionId = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);

/** One of the person's organizations, for the switcher (most recently opened first). */
export const OrganizationSummary = OrganizationRef.extend({
  role: Role,
  lastOpenedAt: z.string().nullable(),
});
export type OrganizationSummary = z.infer<typeof OrganizationSummary>;

const RESERVED_SLUGS = [
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "dev",
  "help",
  "invite",
  "login",
  "mcp",
  "new",
  "oauth",
  "onboarding",
  "profile",
  "settings",
  "signin",
  "signup",
  "sign-in",
  "sign-up",
  "static",
  "status",
  "support",
  "www",
];

/** Slugs kept free for vanity URLs and subdomains later. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.includes(slug);
}

export const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Use at least 3 characters.")
  .max(48, "Use at most 48 characters.")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens.")
  .refine((slug) => !isReservedSlug(slug), "That one is reserved. Pick another.");

/** "Three Pigs Construction" → "three-pigs-construction". Pads or trims to a valid length. */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const padded = base.length >= 3 ? base : `${base || "company"}-co`.replace(/^-/, "");
  return isReservedSlug(padded) ? `${padded}-co` : padded;
}

/** "Bea Brickley" → "Bea Brickley's company": what `/onboarding` suggests naming their company. */
export function personalOrganizationName(name: string): string {
  const trimmed = name.trim();
  return `${trimmed}${trimmed.endsWith("s") ? "'" : "'s"} company`;
}

const organizationName = z
  .string()
  .trim()
  .min(1, "Enter the company's name.")
  .max(100, "Use at most 100 characters.");

/** `organization.get`: the open organization, the caller's role and what they may do. */
export const OrganizationView = OrganizationRef.extend({
  role: Role,
  permissions: z.array(PermissionId),
  createdAt: z.string(),
});
export type OrganizationView = z.infer<typeof OrganizationView>;

export const OrganizationGetInput = z.object({});

export const OrganizationUpdateInput = z
  .object({ name: organizationName.optional(), slug: Slug.optional() })
  .refine((input) => input.name !== undefined || input.slug !== undefined, {
    message: "Say what to change: name, slug or both.",
  });
export type OrganizationUpdateInput = z.infer<typeof OrganizationUpdateInput>;

export const TransferOwnershipInput = z.object({
  /** The member who becomes the owner. You become an admin. */
  userId: z.uuid("Pick a member."),
});
export type TransferOwnershipInput = z.infer<typeof TransferOwnershipInput>;

export const LeaveOrganizationInput = z.object({});

export const DeleteOrganizationInput = z.object({
  /** The company's name, typed out: deleting is never one click. */
  confirmName: z.string().trim().min(1, "Type the company's name to confirm."),
});
export type DeleteOrganizationInput = z.infer<typeof DeleteOrganizationInput>;

/** What leaving or deleting did to the session: the organization it opened next, if any. */
export const OrganizationExit = z.object({
  ok: z.literal(true),
  next: OrganizationRef.nullable(),
});
export type OrganizationExit = z.infer<typeof OrganizationExit>;

/** `POST /api/organizations` and `/onboarding`. */
export const OrganizationCreateInput = z.object({
  name: organizationName,
  slug: Slug.optional(),
});
export type OrganizationCreateInput = z.infer<typeof OrganizationCreateInput>;

export const SwitchOrganizationInput = z.object({ organizationId: z.uuid() });
export type SwitchOrganizationInput = z.infer<typeof SwitchOrganizationInput>;

export const Member = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  title: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: Role,
  joinedAt: z.string(),
  /** The caller's own row. */
  you: z.boolean(),
});
export type Member = z.infer<typeof Member>;

export const MemberList = z.object({ members: z.array(Member) });
export type MemberList = z.infer<typeof MemberList>;

export const MembersListInput = z.object({});

export const MemberUpdateRoleInput = z.object({
  userId: z.uuid("Pick a member."),
  role: Role,
});
export type MemberUpdateRoleInput = z.infer<typeof MemberUpdateRoleInput>;

export const MemberRemoveInput = z.object({ userId: z.uuid("Pick a member.") });
export type MemberRemoveInput = z.infer<typeof MemberRemoveInput>;

export const InviteRoleSchema = z.enum(INVITE_ROLES);

export const Invite = z.object({
  id: z.string(),
  email: z.string(),
  role: InviteRoleSchema,
  invitedBy: z.object({ userId: z.string().nullable(), name: z.string().nullable() }),
  expiresAt: z.string(),
  lastSentAt: z.string(),
  sendCount: z.number().int(),
  expired: z.boolean(),
  createdAt: z.string(),
});
export type Invite = z.infer<typeof Invite>;

export const InviteList = z.object({ invites: z.array(Invite) });
export type InviteList = z.infer<typeof InviteList>;

export const InvitesListInput = z.object({});

export const InviteCreateInput = z.object({ email, role: InviteRoleSchema.default("member") });
export type InviteCreateInput = z.infer<typeof InviteCreateInput>;

export const InviteRef = z.object({ inviteId: z.uuid("Pick an invitation.") });
export type InviteRef = z.infer<typeof InviteRef>;

/** `invites.create`: `resent` when the address already had a pending invite. */
export const InviteSent = Invite.extend({ resent: z.boolean() });
export type InviteSent = z.infer<typeof InviteSent>;

/** `GET /api/invites/:token`: what the invitation page shows before anyone signs in. */
export const InvitePreview = z.object({
  organization: z.object({ id: z.string(), name: z.string() }),
  invitedBy: z.string().nullable(),
  role: InviteRoleSchema,
  /** The address it was sent to: sign-up fixes the email to it. */
  email: z.string(),
  expiresAt: z.string(),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

export const InviteAcceptInput = z.object({ token: z.string().min(1).max(200) });
export type InviteAcceptInput = z.infer<typeof InviteAcceptInput>;

/** A pending invitation to the signed-in person's verified email, offered on `/onboarding`. */
export const PendingInvite = z.object({
  id: z.string(),
  organization: z.object({ id: z.string(), name: z.string() }),
  invitedBy: z.string().nullable(),
  role: InviteRoleSchema,
  expiresAt: z.string(),
});
export type PendingInvite = z.infer<typeof PendingInvite>;

export const JoinPendingInviteInput = z.object({ inviteId: z.uuid() });
export type JoinPendingInviteInput = z.infer<typeof JoinPendingInviteInput>;

// ---------------------------------------------------------------- session

/** Everything the web app needs on first load, in one call (`GET /api/session`). */
export const SessionView = z.object({
  /** Null when signed out. */
  profile: Profile.nullable(),
  /** The person's organizations, most recently opened first (the switcher). Empty when signed out. */
  organizations: z.array(OrganizationSummary),
  /**
   * What the person may do in the open organization. Presentation only (`useCan`): the action
   * registry is the authority.
   */
  permissions: z.array(PermissionId),
  account: z
    .object({
      hasPassword: z.boolean(),
      google: z.object({ linked: z.boolean(), email: z.string().nullable() }),
    })
    .nullable(),
  signInMethods: z.array(SignInMethod),
  /** Whether an MCP client may connect before the email is verified. */
  mcpRequiresVerifiedEmail: z.boolean(),
  /** The `/mcp` URL clients connect to. */
  mcpUrl: z.string(),
  environment: z.enum(["local", "staging", "production", "test"]),
});
export type SessionView = z.infer<typeof SessionView>;

// ---------------------------------------------------------------- auth routes (not actions)

export const SignUpInput = z.object({ name, email, password });
export type SignUpInput = z.infer<typeof SignUpInput>;

export const SignInInput = z.object({ email, password: z.string().min(1, "Enter your password.") });
export type SignInInput = z.infer<typeof SignInInput>;

export const ForgotPasswordInput = z.object({ email });
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>;

export const ResetPasswordInput = z.object({ token: z.string().min(1), password });
export type ResetPasswordInput = z.infer<typeof ResetPasswordInput>;

export const VerifyEmailInput = z.object({ token: z.string().min(1) });
export type VerifyEmailInput = z.infer<typeof VerifyEmailInput>;

export const ChangeEmailInput = z.object({
  email,
  currentPassword: z.string().min(1, "Enter your current password."),
});
export type ChangeEmailInput = z.infer<typeof ChangeEmailInput>;

export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: password,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

/** For an account that has no password yet (Google only). */
export const SetPasswordInput = z.object({ newPassword: password });
export type SetPasswordInput = z.infer<typeof SetPasswordInput>;

export const DeleteAccountInput = z.object({
  /** Required when the account has a password. */
  currentPassword: z.string().optional(),
  confirm: z.literal("DELETE", { error: "Type DELETE to confirm." }),
});
export type DeleteAccountInput = z.infer<typeof DeleteAccountInput>;

/** What a verify, reset or change-email link did, for the screen that opened it. */
export const EmailTokenResult = z.object({
  ok: z.literal(true),
  purpose: z.enum(["verify", "reset", "change_email"]),
  email: z.string(),
});
export type EmailTokenResult = z.infer<typeof EmailTokenResult>;

// ---------------------------------------------------------------- MCP connections

export const ScopeId = z.enum(ALL_SCOPES as [string, ...string[]]);

export const Connection = z.object({
  id: z.string(),
  clientName: z.string(),
  scopes: z.array(z.string()),
  connectedAt: z.string(),
  /** When a token from this grant was last accepted at `/mcp`, if known. */
  lastUsedAt: z.string().nullable(),
  /** The company it's connected to. */
  organization: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type Connection = z.infer<typeof Connection>;

export const ConsentView = z.object({
  handle: z.string(),
  clientName: z.string(),
  clientUri: z.string().nullable(),
  logoUri: z.string().nullable(),
  /** The host the client will be sent back to, so a look-alike client is visible. */
  redirectHost: z.string(),
  /** Every scope the client asked for (always including the read scopes). */
  scopes: z.array(z.object({ id: z.string(), description: z.string(), required: z.boolean() })),
  /** Whether the email must be verified before allowing, and isn't yet. */
  needsVerifiedEmail: z.boolean(),
  /**
   * The companies the connection could be for. A connection is for one company; connecting a
   * second company is a second connection.
   */
  organizations: z.array(OrganizationRef.extend({ role: Role })),
  /** The company picked by default: the open one. */
  organizationId: z.string().nullable(),
});
export type ConsentView = z.infer<typeof ConsentView>;

export const ConsentDecision = z.object({
  handle: z.string().min(1),
  decision: z.enum(["allow", "cancel"]),
  scopes: z.array(z.string()).default([]),
  /** The company the connection is for; the open one when left out. */
  organizationId: z.uuid().optional(),
});
export type ConsentDecision = z.infer<typeof ConsentDecision>;

// ---------------------------------------------------------------- development mail

export const CapturedMail = z.object({
  id: z.string(),
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  html: z.string(),
  sentAt: z.string(),
  /** The first link in the message, for the dev mail page and the e2e tests. */
  link: z.string().nullable(),
});
export type CapturedMail = z.infer<typeof CapturedMail>;

// ---------------------------------------------------------------- browser errors

/** What `apps/web` reports to `POST /api/client-errors`. Capped: it's logged, never stored. */
export const ClientErrorReport = z.object({
  kind: z.enum(["error", "unhandledrejection", "react"]),
  message: z.string().max(1000),
  stack: z.string().max(4000).optional(),
  /** The route path (no query string; the reporter strips it). */
  path: z.string().max(300),
  /** The request id of the failed API call, if the error came from one. */
  requestId: z.string().max(64).optional(),
});
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

export const Health = z.object({ ok: z.boolean(), version: z.string(), commit: z.string() });
export type Health = z.infer<typeof Health>;
