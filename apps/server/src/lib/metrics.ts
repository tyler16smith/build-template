import { metricDataPoint, SLOW_QUERY_MS, type MetricPoint } from "@template/contracts";
import type { StatementTiming } from "@template/db";
import type { Env } from "../env";
import type { Logger } from "./log";

/**
 * Writes `METRIC_SCHEMA` points to Analytics Engine without waiting (`writeDataPoint` is
 * fire-and-forget). Absent locally and in tests, where nothing is written.
 */
export function recordMetric(env: Env, point: MetricPoint, log?: Logger): void {
  try {
    env.METRICS?.writeDataPoint(metricDataPoint(point));
  } catch (error) {
    log?.warn("metric.not_written", { kind: point.kind, error });
  }
}

/** The version tag every line and point carries: the commit CI deployed (`--tag <sha>`). */
export function versionTag(env: Env): string {
  return env.CF_VERSION?.tag || env.CF_VERSION?.id || "local";
}

/**
 * The data layer's timing hook for one request: counts round trips, and records any batch or
 * transaction that took `SLOW_QUERY_MS` or more as a `query` point and a `warn` line, by name.
 */
export function timingRecorder(
  env: Env,
  log: Logger,
  organizationId: () => string | null,
): { onTiming: (timing: StatementTiming) => void; roundTrips: () => number } {
  let trips = 0;
  return {
    roundTrips: () => trips,
    onTiming(timing) {
      trips += timing.kind === "batch" ? 1 : Math.max(1, timing.statements);
      if (timing.ms < SLOW_QUERY_MS) return;
      log.warn("query.slow", {
        query: timing.name,
        durationMs: Math.round(timing.ms),
        statements: timing.statements,
        kind: timing.kind,
      });
      recordMetric(env, {
        organizationId: organizationId(),
        requestId: log.requestId,
        kind: "query",
        name: timing.name,
        outcome: "ok",
        version: versionTag(env),
        durationMs: timing.ms,
        roundTrips: timing.kind === "batch" ? 1 : timing.statements,
      });
    },
  };
}
