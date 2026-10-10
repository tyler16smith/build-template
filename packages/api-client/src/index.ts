import {
  ORGANIZATION_HEADER,
  PATHS,
  type ActionId,
  type AgentKind,
  type ActionInput,
  type ActionOutput,
  type ApiError,
  type CapturedMail,
  type ChangeEmailInput,
  type ChangePasswordInput,
  type ClientErrorReport,
  type Connection,
  type ConsentDecision,
  type ConsentView,
  type DeleteAccountInput,
  type EmailTokenResult,
  type ErrorCode,
  type Health,
  type InvitePreview,
  type OrganizationCreateInput,
  type OrganizationRef,
  type PendingInvite,
  type ResetPasswordInput,
  type SessionView,
  type SetPasswordInput,
  type SignInInput,
  type SignUpInput,
} from "@template/contracts";

/**
 * The typed client for the server: every action (`client.profile.update(input)`, types inferred
 * from `@template/contracts`, no code generation) and the auth endpoints. Plain `fetch`, no DOM,
 * so the web app, a desktop shell or a test can use it.
 */
export class ApiClientError extends Error {
  override name = "ApiClientError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

export type ApiClientOptions = {
  /** "" for same-origin (the web app); a full origin for other clients. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** A bearer token instead of the session cookie (native and desktop clients). */
  token?: () => string | null;
  /** Called with every failed call, before it's thrown (the web app reports `internal` ones). */
  onError?: (error: ApiClientError) => void;
  /**
   * Which organization the client works in, learned from session payloads and sent as
   * `X-Organization-Id`. Clients that should agree (the web app's two) share one tracker.
   */
  organization?: OrganizationTracker;
  /**
   * Opens an agent connection (`/agents/<kind>/<name>`, same origin). The web app passes one
   * built on the Agents SDK's client; a desktop shell provides its own.
   */
  connectAgent?: (kind: AgentKind, name: string) => AgentConnection;
};

/**
 * An open connection to an agent (the Agents SDK's client socket). Opaque here: screens hand it
 * to `useAgentChat` and close it when they unmount.
 */
export type AgentConnection = { readonly agent: string; readonly name: string; close(): void };

/**
 * The organization a client last saw open. `onChange` runs when it changes (a switch, a new
 * company, an accepted invitation, or a session that opened another one): the web app tells its
 * other tabs.
 */
export type OrganizationTracker = {
  current: string | null;
  seen: boolean;
  onChange?: (organizationId: string | null) => void;
};

export function organizationTracker(
  onChange?: (organizationId: string | null) => void,
): OrganizationTracker {
  return { current: null, seen: false, onChange };
}

type Split<Id extends string> = Id extends `${infer Module}.${infer Name}` ? [Module, Name] : never;
type ModuleOf<Id extends string> = Split<Id>[0];

/** `{ profile: { get(input), update(input) } }`, from the action ids. */
export type ActionMethods = {
  [M in ModuleOf<ActionId>]: {
    [Id in ActionId as Split<Id>[0] extends M ? Split<Id>[1] : never]: (
      ...input: {} extends ActionInput<Id> ? [input?: ActionInput<Id>] : [input: ActionInput<Id>]
    ) => Promise<ActionOutput<Id>>;
  };
};

export type ApiClient = ActionMethods & {
  /** Any action by id. */
  action<Id extends ActionId>(id: Id, input: ActionInput<Id>): Promise<ActionOutput<Id>>;
  session(): Promise<SessionView>;
  /**
   * The organization the client last saw open (from the session). Sent as `X-Organization-Id`
   * with every call, so a call from a page loaded for another organization is refused
   * (`organization_changed`) instead of landing in the wrong company.
   */
  organizationId(): string | null;
  health(): Promise<Health>;
  auth: {
    signUp(input: SignUpInput): Promise<void>;
    signIn(input: SignInInput): Promise<void>;
    signOut(): Promise<void>;
    signOutEverywhere(): Promise<void>;
    forgotPassword(email: string): Promise<void>;
    resetPassword(input: ResetPasswordInput): Promise<void>;
    verifyEmail(token: string): Promise<EmailTokenResult>;
    resendVerification(): Promise<{ alreadyVerified: boolean }>;
    changeEmail(input: ChangeEmailInput): Promise<void>;
    changePassword(input: ChangePasswordInput): Promise<void>;
    setPassword(input: SetPasswordInput): Promise<void>;
    unlinkGoogle(): Promise<void>;
    deleteAccount(input: DeleteAccountInput): Promise<void>;
    /** Companies the person is the only owner of (with other members): they block deletion. */
    deletionBlockers(): Promise<OrganizationRef[]>;
    /** Opens another of the person's companies; returns the new session. */
    switchOrganization(organizationId: string): Promise<SessionView>;
    /** Where to send the browser to continue with Google, coming back to `returnTo`. */
    googleUrl(returnTo?: string): string;
  };
  /** Creating a company (`/onboarding`, the switcher). Returns the new session, with it open. */
  organizations: {
    create(input: OrganizationCreateInput): Promise<SessionView>;
  };
  /**
   * Invitations before the person is in the company (auth routes, not actions: the `invites.*`
   * actions are for admins inside it).
   */
  invitations: {
    preview(token: string): Promise<InvitePreview>;
    /** Accepts the link's invitation; returns the new session, with its company open. */
    accept(token: string): Promise<SessionView>;
    /** Invitations to the signed-in person's verified email (`/onboarding`). */
    pending(): Promise<PendingInvite[]>;
    join(inviteId: string): Promise<SessionView>;
  };
  connections: {
    list(): Promise<Connection[]>;
    revoke(id: string): Promise<void>;
  };
  consent: {
    get(handle: string): Promise<ConsentView>;
    /** Returns where to send the browser next (back to the client). */
    decide(decision: ConsentDecision): Promise<{ redirectTo: string }>;
  };
  dev: { mail(): Promise<CapturedMail[]> };
  reportError(report: ClientErrorReport): Promise<void>;
  /** The Assistant and the Automation Builder's socket. Throws when the client has none. */
  connectAgent(kind: AgentKind, name: string): AgentConnection;
};

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const base = options.baseUrl ?? "";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const tracker = options.organization ?? organizationTracker();

  /** Remembers the open organization from a session payload. */
  function track(view: SessionView): SessionView {
    const next = view.profile?.organization?.id ?? null;
    const changed = tracker.seen && next !== tracker.current;
    tracker.current = next;
    tracker.seen = true;
    if (changed) tracker.onChange?.(next);
    return view;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (tracker.current) headers[ORGANIZATION_HEADER] = tracker.current;
    const token = options.token?.();
    if (token) headers.authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch {
      const error = new ApiClientError(
        "rate_limited",
        "We couldn't reach the server. Check your connection and try again.",
        0,
      );
      options.onError?.(error);
      throw error;
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const failure = (data as { error?: ApiError } | null)?.error;
      const error = new ApiClientError(
        failure?.code ?? (response.status >= 500 ? "internal" : "invalid_input"),
        failure?.message ?? "Something went wrong. Try again.",
        response.status,
        failure?.fields ?? {},
        failure?.requestId ?? response.headers.get("x-request-id"),
      );
      options.onError?.(error);
      throw error;
    }
    return data as T;
  }

  const post = <T = void>(path: string, body: unknown = {}) => request<T>("POST", path, body);
  const done = async (promise: Promise<unknown>) => {
    await promise;
  };

  const action = <Id extends ActionId>(id: Id, input: ActionInput<Id>) =>
    post<ActionOutput<Id>>(`/api/actions/${id}`, input ?? {});

  const sessionPost = async (path: string, body: unknown = {}) =>
    track(await post<SessionView>(path, body));

  const client = {
    action,
    session: async () => track(await request<SessionView>("GET", "/api/session")),
    organizationId: () => tracker.current,
    health: () => request<Health>("GET", "/api/health"),
    auth: {
      signUp: (input) => done(post("/api/auth/sign-up", input)),
      signIn: (input) => done(post("/api/auth/sign-in", input)),
      signOut: () => done(post("/api/auth/sign-out")),
      signOutEverywhere: () => done(post("/api/auth/sign-out-everywhere")),
      forgotPassword: (email) => done(post("/api/auth/forgot-password", { email })),
      resetPassword: (input) => done(post("/api/auth/reset-password", input)),
      verifyEmail: (token) => post<EmailTokenResult>("/api/auth/verify-email", { token }),
      resendVerification: () => post<{ alreadyVerified: boolean }>("/api/auth/resend-verification"),
      changeEmail: (input) => done(post("/api/auth/change-email", input)),
      changePassword: (input) => done(post("/api/auth/change-password", input)),
      setPassword: (input) => done(post("/api/auth/set-password", input)),
      unlinkGoogle: () => done(post("/api/auth/unlink-google")),
      deleteAccount: (input) => done(post("/api/auth/delete-account", input)),
      deletionBlockers: async () =>
        (await request<{ organizations: OrganizationRef[] }>("GET", "/api/auth/deletion-blockers"))
          .organizations,
      switchOrganization: (id) =>
        sessionPost("/api/auth/switch-organization", { organizationId: id }),
      googleUrl: (returnTo = "/") =>
        `${base}${PATHS.googleStart}?returnTo=${encodeURIComponent(returnTo)}`,
    },
    organizations: {
      create: (input) => sessionPost("/api/organizations", input),
    },
    invitations: {
      preview: (token) =>
        request<InvitePreview>("GET", `/api/invites/${encodeURIComponent(token)}`),
      accept: (token) => sessionPost("/api/invites/accept", { token }),
      pending: async () =>
        (await request<{ invites: PendingInvite[] }>("GET", "/api/invites")).invites,
      join: (inviteId) => sessionPost("/api/invites/join", { inviteId }),
    },
    connections: {
      list: async () =>
        (await request<{ connections: Connection[] }>("GET", "/api/connections")).connections,
      revoke: (id) => done(request("DELETE", `/api/connections/${encodeURIComponent(id)}`)),
    },
    consent: {
      get: (handle) =>
        request<ConsentView>("GET", `/api/oauth/consent/${encodeURIComponent(handle)}`),
      decide: (decision) => post<{ redirectTo: string }>("/api/oauth/consent", decision),
    },
    dev: {
      mail: async () => (await request<{ mail: CapturedMail[] }>("GET", "/api/dev/mail")).mail,
    },
    reportError: (report) => done(post("/api/client-errors", report)),
    connectAgent: (kind, name) => {
      if (!options.connectAgent) throw new Error("This client can't open agent connections");
      return options.connectAgent(kind, name);
    },
  } satisfies Omit<ApiClient, keyof ActionMethods>;

  // `client.profile.update(input)` → `POST /api/actions/profile.update`. Built on access, so the
  // client needs no runtime copy of the contracts (and the web app doesn't ship zod for it).
  const modules = new Map<string, Record<string, (input?: unknown) => Promise<unknown>>>();
  const moduleProxy = (module: string) =>
    new Proxy({} as Record<string, (input?: unknown) => Promise<unknown>>, {
      get: (_target, name) =>
        typeof name === "string"
          ? (input?: unknown) => action(`${module}.${name}` as ActionId, (input ?? {}) as never)
          : undefined,
    });
  return new Proxy(client, {
    get(target, key, receiver) {
      if (typeof key !== "string" || key in target) return Reflect.get(target, key, receiver);
      let methods = modules.get(key);
      if (!methods) modules.set(key, (methods = moduleProxy(key)));
      return methods;
    },
  }) as ApiClient;
}
