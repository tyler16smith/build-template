/**
 * Bindings and secrets (`wrangler.jsonc`, `.dev.vars.example`). Optional ones are absent in some
 * environments: Google until it's configured, Analytics Engine locally.
 */
/** What a Workflow instance is started with: ids only, never a secret or the definition. */
export type AutomationRunParams = {
  organizationId: string;
  runId: string;
  triggerPayload: unknown;
};

export type Environment = "local" | "staging" | "production" | "test";

export type Env = {
  ASSETS: Fetcher;
  OAUTH_KV: KVNamespace;
  /** Hyperdrive for interactive transactions (locally: the Docker Postgres). */
  HYPERDRIVE?: Hyperdrive;
  /** The Neon runtime URL (`app_runtime`), for one-request batches over HTTP. Unset locally. */
  DATABASE_URL?: string;
  /** Tests only: a SQL proxy to PGlite in the test runner (`test/sql-proxy.ts`). */
  TEST_SQL?: Fetcher;

  ENVIRONMENT: Environment;
  /** `https://app.example.com` in deployed environments; locally the request's origin is used. */
  APP_ORIGIN?: string;
  APP_NAME: string;
  SESSION_PEPPER: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "false" lets an MCP client connect before the email is verified. On by default. */
  MCP_REQUIRE_VERIFIED_EMAIL?: string;
  /** Staging only: lets the e2e suite read mail sent to `.example` addresses. */
  TEST_MAIL_SECRET?: string;

  /** Rate limits (Workers Rate Limiting). */
  AUTH_LIMIT: RateLimit;
  REGISTER_LIMIT: RateLimit;
  CLIENT_ERROR_LIMIT: RateLimit;

  // ---- AI and automations (specs/ai.md)
  /** Workers AI: the fallback model when no provider key is set, and the AI Gateway binding. */
  AI?: Ai;
  /** The AI Gateway every model call goes through (logs, caching, spend). */
  AI_GATEWAY_ID?: string;
  /** Anthropic's key. Without it the Assistant runs on Workers AI. */
  ANTHROPIC_API_KEY?: string;
  /** The models offered, comma-separated, default first (`KNOWN_MODELS` ids). */
  AI_MODELS?: string;
  /** Seals Zapier hook URLs and webhook signing secrets (AES-GCM, base64 32 bytes). */
  CONNECTION_ENCRYPTION_KEY?: string;
  AssistantAgent: DurableObjectNamespace;
  AutomationAgent: DurableObjectNamespace;
  AUTOMATION_WORKFLOW: Workflow<AutomationRunParams>;
  /** Zapier deliveries per connection (Workers Rate Limiting), before any database work. */
  ZAPIER_LIMIT?: RateLimit;

  METRICS?: AnalyticsEngineDataset;
  CF_VERSION?: WorkerVersionMetadata;
};
