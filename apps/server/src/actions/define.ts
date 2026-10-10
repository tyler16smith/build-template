import type { Accounts, Organizations } from "@template/auth";
import {
  roleCan,
  type ActionContract,
  type OrganizationRef,
  type Permission,
  type Profile,
  type ProfileUpdateInput,
  type Role,
  type Scope,
} from "@template/contracts";
import type { Database, TenantContext, TenantDb } from "@template/db";
import type { z } from "zod";
import type { RuntimeContext } from "../lib/context";
import type { Logger } from "../lib/log";
import type { Mail } from "../lib/mail";
import { revokeGrantsIn } from "../mcp/oauth";

/**
 * Who called an action: the web app (session cookie), an MCP client, another client with a token
 * (`api`), the Assistant (`specs/ai.md`) and an automation step.
 */
export type Caller = "web" | "mcp" | "api" | "assistant" | "automation";

/** `Organizations`' methods for one verified organization and person (`ctx.organizations`). */
export type OrganizationAccess = {
  [
    K in keyof Organizations as Organizations[K] extends (
      context: TenantContext,
      ...rest: infer _R
    ) => unknown
      ? K
      : never
  ]: Organizations[K] extends (context: TenantContext, ...rest: infer R) => infer O
    ? (...rest: R) => O
    : never;
};

/**
 * What a handler gets. The pipeline builds it only after it has verified the person and their
 * membership; the organization comes from the session or token, never from input.
 *
 * ```ts
 * ctx.user.id;
 * ctx.organization.id; // also name and slug
 * ctx.membership.role;
 * ctx.can("members.manage"); // boolean, for shaping output
 * requirePermission(ctx, "members.manage"); // throws ActionError("forbidden", …)
 * ```
 */
export type ActionContext = {
  requestId: string;
  log: Logger;
  user: { id: string; emailVerified: boolean };
  organization: OrganizationRef;
  /** Never compare it: ask `ctx.can(permission)` (`packages/contracts/src/permissions.ts`). */
  membership: { role: Role };
  /** Whether the caller's role holds the permission. For shaping output; checks use `requirePermission`. */
  can(permission: Permission): boolean;
  scopes: readonly Scope[];
  caller: Caller;
  /**
   * The person approved this exact call: they did it themselves in the app, or an agent asked
   * them first. A handler about to make a large change (a bulk delete) throws
   * `confirmation_required` while this is false.
   */
  confirmed: boolean;
  /** Tenant tables, scoped to `org` (and to it again by row-level security). */
  db: TenantDb;
  /** The person's own identity record (identity tables are reached only through `@template/auth`). */
  account: {
    profile(): Promise<Profile>;
    updateProfile(input: ProfileUpdateInput): Promise<Profile>;
  };
  /** Members, invitations and the organization's own record, scoped to `organization`. */
  organizations: OrganizationAccess;
  /** The app's name and canonical origin, for emails and links. */
  app: { name: string; origin: string };
  /** Sends an email (`lib/emails.ts` builds them). */
  sendMail(mail: Mail): Promise<void>;
  /** Revokes a person's connected apps (OAuth grants) for this organization. */
  revokeConnections(userId: string): Promise<number>;
  /**
   * The runtime under the action (env bindings, the Workflow, agents). Only for the modules ported
   * with their own services (`automations`, `zapier`, `assistant`), through `scopeOf(ctx)`. A new
   * module uses the fields above; if it needs a binding, add a narrow field here instead.
   */
  runtime: RuntimeContext;
};

export type ServerAction<
  Id extends string = string,
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> = ActionContract<Id, Input, Output> & {
  handler: (ctx: ActionContext, input: z.output<Input>) => Promise<z.input<Output>>;
};

/**
 * An action: its contract from `@template/contracts` plus a handler. The registry serves it as
 * `POST /api/actions/<id>`, the MCP tool `<module>_<name>` and `client.<module>.<name>()`.
 *
 * ```ts
 * export const updateProfile = defineAction({
 *   ...profileUpdate, // id, title, description, input, output, scope
 *   handler: async (ctx, input) => ctx.account.updateProfile(input),
 * });
 * ```
 */
export function defineAction<
  const Id extends string,
  Input extends z.ZodType,
  Output extends z.ZodType,
>(action: ServerAction<Id, Input, Output>): ServerAction<Id, Input, Output> {
  return action;
}

/** A person the caller has already verified, in an organization they're a member of. */
export type VerifiedCaller = {
  userId: string;
  organizationId: string;
  /** The organization's name and slug when the caller already read them (a session, a profile). */
  organization?: Pick<OrganizationRef, "name" | "slug">;
  role: Role;
  emailVerified: boolean;
  scopes: readonly Scope[];
  caller: Caller;
  /** See `ActionContext.confirmed`. The web app's own calls are the person's. */
  confirmed?: boolean;
  /** Set when an automation step is the caller, so its writes never retrigger it. */
  automation?: { automationId: string; runId: string; depth: number };
};

/**
 * The one place an `ActionContext` is built, and so the one place tenant scope is decided: the
 * data layer is scoped to `caller.organizationId`, which the caller verified (a session, a token,
 * an Assistant Durable Object or a Workflow step, which have no request).
 */
export function buildActionContext(options: {
  runtime: RuntimeContext;
  database: Database;
  accounts: Accounts;
  caller: VerifiedCaller;
  organization: OrganizationRef;
  actionId: string;
  requestId: string;
  log: Logger;
}): ActionContext {
  const { database, accounts, caller } = options;
  const context = { userId: caller.userId, organizationId: caller.organizationId };
  const organizations = accounts.organizations;
  const bound = new Proxy({} as OrganizationAccess, {
    get: (_target, key) => {
      const method = (organizations as unknown as Record<string, unknown>)[key as string];
      return typeof method === "function"
        ? (...rest: unknown[]) => method.call(organizations, context, ...rest)
        : undefined;
    },
  });
  return {
    requestId: options.requestId,
    log: options.log,
    user: { id: caller.userId, emailVerified: caller.emailVerified },
    organization: { ...options.organization, id: caller.organizationId },
    membership: { role: caller.role },
    can: (permission) => roleCan(caller.role, permission),
    scopes: caller.scopes,
    caller: caller.caller,
    confirmed: caller.confirmed ?? caller.caller === "web",
    db: database.tenant(context, { label: options.actionId }),
    account: {
      profile: () => accounts.profile(context),
      updateProfile: (input) => accounts.updateProfile(context, input),
    },
    organizations: bound,
    app: { name: options.runtime.env.APP_NAME, origin: options.runtime.origin },
    sendMail: (mail) => options.runtime.mailer.send(mail),
    revokeConnections: (userId) => revokeGrantsIn(options.runtime, userId, caller.organizationId),
    runtime: options.runtime,
  };
}
