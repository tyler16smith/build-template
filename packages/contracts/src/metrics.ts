/**
 * The Analytics Engine data point layout (ported from Custombase's `reliability/latency.ts`).
 * Fixed and append-only: queries read fields by position, so a new field is appended as the next
 * blob or double, never inserted or reordered.
 *
 * - index1: organization id ("" when there is none, such as a sign-in or a health check);
 * - blobs: kind, name (route, action id, query or job name), outcome, error code, version tag,
 *   MCP client name, error fingerprint (empty unless the outcome is `failure`), request id;
 * - doubles: duration (ms), HTTP status, database round trips.
 */
/** `agent`: an Assistant or Automation Builder turn. `automation`: one automation step. */
export const METRIC_KINDS = [
  "request",
  "action",
  "mcp",
  "query",
  "job",
  "agent",
  "automation",
] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/** `expected_error`: validation, not found, permission denied, rate limited. Never a failure. */
export const METRIC_OUTCOMES = ["ok", "expected_error", "failure"] as const;
export type MetricOutcome = (typeof METRIC_OUTCOMES)[number];

export const METRIC_SCHEMA = {
  dataset: "app_metrics",
  index: ["organizationId"],
  blobs: [
    "kind",
    "name",
    "outcome",
    "errorCode",
    "version",
    "mcpClient",
    "fingerprint",
    "requestId",
  ],
  doubles: ["durationMs", "status", "roundTrips"],
} as const;

export type MetricPoint = {
  organizationId: string | null;
  kind: MetricKind;
  name: string;
  outcome: MetricOutcome;
  errorCode?: string | null;
  version: string;
  mcpClient?: string | null;
  /** Only for failures: groups them (`apps/server/src/lib/errors.ts`, `fingerprint`). */
  fingerprint?: string | null;
  requestId?: string | null;
  durationMs: number;
  status?: number;
  roundTrips?: number;
};

/** A point in Analytics Engine's shape, in `METRIC_SCHEMA` order. */
export function metricDataPoint(point: MetricPoint): {
  indexes: string[];
  blobs: string[];
  doubles: number[];
} {
  return {
    indexes: [(point.organizationId ?? "").slice(0, 96)],
    blobs: [
      point.kind,
      point.name.replace(/[?#].*$/s, "").slice(0, 200),
      point.outcome,
      point.outcome === "ok" ? "" : (point.errorCode ?? "").slice(0, 60),
      point.version.slice(0, 64),
      (point.mcpClient ?? "").slice(0, 100),
      point.outcome === "failure" ? (point.fingerprint ?? "").slice(0, 64) : "",
      (point.requestId ?? "").slice(0, 64),
    ],
    doubles: [Math.max(0, point.durationMs), point.status ?? 0, point.roundTrips ?? 0],
  };
}

/** A statement at least this slow is recorded as a `query` point. */
export const SLOW_QUERY_MS = 200;
