import { ActionError, type Role } from "@template/contracts";
import type { TenantDb } from "@template/db";
import type { ActionContext } from "../../actions/define";
import type { RuntimeContext } from "../../lib/context";

/** A person acting in an organization: from a session, an agent's name or a run's run-as person. */
export type Principal = { organizationId: string; userId: string; role: Role };

/** What every automation function gets: the runtime, the data layer scoped to the person, and them. */
export type Scope = { ctx: RuntimeContext; db: TenantDb; principal: Principal };

export function scopeFor(ctx: RuntimeContext, principal: Principal, label: string): Scope {
  return {
    ctx,
    principal,
    db: ctx
      .database()
      .tenant({ organizationId: principal.organizationId, userId: principal.userId }, { label }),
  };
}

/** An action's caller as a `Scope`, for the services of the modules ported with them. */
export function scopeOf(ctx: ActionContext): Scope {
  return {
    ctx: ctx.runtime,
    db: ctx.db,
    principal: {
      organizationId: ctx.organization.id,
      userId: ctx.user.id,
      role: ctx.membership.role,
    },
  };
}

/** The person's current role here, or null when they're no longer a member. */
export async function currentRole(
  ctx: RuntimeContext,
  organizationId: string,
  userId: string,
): Promise<Role | null> {
  try {
    return (await ctx.accounts().profile({ organizationId, userId })).role;
  } catch (error) {
    if (error instanceof ActionError && error.code === "not_found") return null;
    throw error;
  }
}

export const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;
