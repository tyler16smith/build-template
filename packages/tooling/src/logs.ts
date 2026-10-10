import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type Env } from "./shared";

/**
 * `pnpm logs --env staging|production [--request <id>] [--fingerprint <f>] [--level error]
 * [--since 1h]`: the Worker's own log lines from the Workers Logs telemetry API (ported from
 * Custombase's `reliability/logs/query.ts`). Built for people now and agents later. Needs
 * `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers Observability read), a local and
 * CI secret, never a Worker secret.
 */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const MAX_HOURS = 24 * 7;

export type LogQuery = {
  script: string;
  from: number;
  to: number;
  requestId?: string;
  fingerprint?: string;
  level?: "error" | "warn" | "info";
  limit?: number;
};

/** The Worker's name in an environment, from wrangler.jsonc. */
export function scriptName(env: Exclude<Env, "local">): string {
  const config = readFileSync(join(ROOT, "apps/server/wrangler.jsonc"), "utf8");
  const block = config.slice(config.indexOf(`"${env}": {`));
  const name = /"name":\s*"([^"]+)"/.exec(block)?.[1];
  if (!name) throw new Error(`No Worker name for ${env} in apps/server/wrangler.jsonc`);
  return name;
}

export function parseSince(value: string | undefined, now = Date.now()): number {
  const match = /^(\d+)\s*(m|h|d)$/.exec(value ?? "1h");
  if (!match) throw new Error("--since takes a duration like 30m, 6h or 2d");
  const ms =
    Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  if (ms > MAX_HOURS * 3_600_000)
    throw new Error("Workers Logs keeps 7 days; use --since 7d or less");
  return now - ms;
}

/**
 * The telemetry query: the script is pinned with an exact match, and everything else only
 * narrows it. Request ids and fingerprints are matched as needles (they appear in each line's
 * JSON). `dry` keeps the query from being saved.
 */
export function buildQuery(query: LogQuery) {
  const filters: { key: string; operation: string; type: string; value: string }[] = [
    { key: "$metadata.service", operation: "eq", type: "string", value: query.script },
  ];
  if (query.level)
    filters.push({ key: "$metadata.level", operation: "eq", type: "string", value: query.level });
  const needle = query.requestId ?? query.fingerprint;
  return {
    queryId: `build-template-logs-${crypto.randomUUID()}`,
    timeframe: { from: query.from, to: query.to },
    view: "events",
    limit: query.limit ?? 100,
    dry: true,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters: filters.map((f) => ({ kind: "filter", ...f })),
      ...(needle ? { needle: { value: needle, isRegex: false, matchCase: false } } : {}),
      limit: query.limit ?? 100,
    },
  };
}

type TelemetryEvent = {
  timestamp?: number;
  $metadata?: { level?: string; message?: string; requestId?: string };
  source?: unknown;
};

export async function queryLogs(
  query: LogQuery,
  fetcher: typeof fetch = fetch,
): Promise<TelemetryEvent[]> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token)
    throw new Error(
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers Observability: read).",
    );
  const response = await fetcher(
    `${CLOUDFLARE_API}/accounts/${account}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(buildQuery(query)),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: { code: number; message: string }[];
    result?: { events?: { events?: TelemetryEvent[] } };
  } | null;
  if (!response.ok || !body?.success)
    throw new Error(
      `Workers Logs answered ${response.status}: ${body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "no detail"}`,
    );
  return (body.result?.events?.events ?? []).sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
  );
}

/** One line per event: time, level, then the JSON our logger wrote. */
export function formatEvent(event: TelemetryEvent): string {
  const time = event.timestamp ? new Date(event.timestamp).toISOString() : "?";
  const level = (event.$metadata?.level ?? "log").padEnd(5);
  const source = event.source;
  const text =
    source && typeof source === "object"
      ? JSON.stringify(source)
      : String(source ?? event.$metadata?.message ?? "");
  return `${time} ${level} ${text}`;
}
