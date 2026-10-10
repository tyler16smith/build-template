import { scheduleMatches } from "@template/contracts";
import { and, automations, automationVersions, eq, NO_ORGANIZATION } from "@template/db";
import type { RuntimeContext } from "../../lib/context";
import { currentRole, scopeFor } from "./context";
import { startRun, withinRateLimit } from "./dispatch";
import { pinnedDefinition } from "./runs";

/** How far back a tick looks for due minutes, so one missed tick loses nothing. */
const LOOKBACK_MINUTES = 12;

/**
 * The five-minute cron: starts every active schedule that fell due in the last few minutes.
 * Each due minute is the run's trigger event id (`schedule:<minute>`), so overlapping ticks start
 * it once, and a minute before the version was published never counts.
 *
 * Listing across organizations uses the `schedule_job` policy (migration 0002), which shows only
 * active schedules' ids; everything after runs as the automation's organization.
 */
export async function dispatchSchedules(
  ctx: RuntimeContext,
  now: Date,
): Promise<{ checked: number; started: number }> {
  const due = await ctx.database().one(
    (d) =>
      d
        .select({ organizationId: automations.organizationId, id: automations.id })
        .from(automations)
        .where(and(eq(automations.triggerKey, "schedule"), eq(automations.status, "active"))),
    { "app.organization_id": NO_ORGANIZATION, "app.job": "automation-schedules" },
    { name: "automation.schedules" },
  );
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  let started = 0;
  for (const { organizationId, id } of due) {
    try {
      const listing = scopeFor(
        ctx,
        { organizationId, userId: NO_ORGANIZATION, role: "member" },
        "automation.schedule",
      );
      const automation = await listing.db.one((q) => q.first(automations, eq(automations.id, id)));
      if (!automation?.activeVersion || !automation.runAsUserId) continue;
      const role = await currentRole(ctx, organizationId, automation.runAsUserId);
      if (!role) continue;
      const scope = scopeFor(
        ctx,
        { organizationId, userId: automation.runAsUserId, role },
        "automation.schedule",
      );
      const definition = await pinnedDefinition(scope.db, automation.id, automation.activeVersion);
      const trigger = definition.trigger;
      if (trigger.kind !== "schedule") continue;
      const version = await scope.db.one((q) =>
        q.first(
          automationVersions,
          and(
            eq(automationVersions.automationId, automation.id),
            eq(automationVersions.version, automation.activeVersion!),
          ),
        ),
      );
      const since = Math.max(
        minute - (LOOKBACK_MINUTES - 1) * 60_000,
        version ? version.createdAt.getTime() : 0,
      );
      for (let at = minute; at >= since; at -= 60_000) {
        const when = new Date(at);
        if (!scheduleMatches(trigger, when)) continue;
        if (!(await withinRateLimit(scope, automation, definition))) {
          ctx.log.warn("automation.rate_limited", { automationId: automation.id });
          break;
        }
        const { deduplicated } = await startRun(scope, {
          automation,
          version: automation.activeVersion,
          definition,
          mode: "live",
          triggerKind: "schedule",
          triggerEventId: `schedule:${when.toISOString()}`,
          triggerPayload: { scheduledFor: when.toISOString(), timezone: trigger.timezone },
          runAsUserId: automation.runAsUserId,
          startedBy: null,
          chainDepth: 0,
        });
        if (!deduplicated) started++;
      }
    } catch (error) {
      ctx.log.error("automation.schedule_failed", {
        automationId: id,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { checked: due.length, started };
}
