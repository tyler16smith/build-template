import { redactValue } from "./redact";

export type LogLevel = "info" | "warn" | "error";

/**
 * What every line carries when it's known. IDs only: never an email, a name or an input.
 * `errorCode` (not `code`: that key is redacted, since OAuth codes travel under it).
 */
export type LogContext = {
  requestId?: string;
  version?: string;
  route?: string;
  actionId?: string;
  organizationId?: string;
  userId?: string;
  source?: "server" | "browser" | "cron" | "agent" | "workflow";
};

export type LogFields = Record<string, unknown> & {
  durationMs?: number;
  errorCode?: string;
  status?: number;
  fingerprint?: string;
};

type Sink = (level: LogLevel, line: string) => void;

/**
 * The only place `apps/server` writes to the console (`pnpm check:boundaries` enforces it).
 * Workers Logs indexes each JSON line's fields.
 */
const consoleSink: Sink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

let sink: Sink = consoleSink;

/** Tests only: capture lines instead of printing them. Returns the previous sink. */
export function setLogSink(next: Sink | null): Sink {
  const previous = sink;
  sink = next ?? consoleSink;
  return previous;
}

const CONTEXT_KEYS = [
  "requestId",
  "version",
  "route",
  "actionId",
  "organizationId",
  "userId",
  "source",
] as const;

/** Only the known context keys, as strings: an object passed by mistake can't smuggle in a secret. */
function pickContext(context: LogContext): LogContext {
  const picked: Record<string, string> = {};
  for (const key of CONTEXT_KEYS) {
    const value = (context as Record<string, unknown>)[key];
    if (typeof value === "string") picked[key] = value;
  }
  return picked as LogContext;
}

/**
 * `ctx.log`: one JSON line per event, with the request's context, every value redacted
 * (`redact.ts`). Credential-named keys are dropped wherever they appear.
 */
export class Logger {
  private readonly context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = pickContext(context);
  }

  /** The same logger with more context (the user, once the session is known). */
  with(context: LogContext): Logger {
    return new Logger({ ...this.context, ...pickContext(context) });
  }

  get requestId(): string | undefined {
    return this.context.requestId;
  }

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const { stack, ...rest } = fields;
    const line = {
      level,
      event,
      ...(redactValue(this.context) as Record<string, unknown>),
      ...(redactValue(rest) as Record<string, unknown>),
      // Stacks name our files and functions; their text is redacted like everything else.
      ...(typeof stack === "string" ? { stack: redactValue(stack) } : {}),
    };
    try {
      sink(level, JSON.stringify(line));
    } catch {
      sink(level, JSON.stringify({ level, event, requestId: this.context.requestId }));
    }
  }
}
