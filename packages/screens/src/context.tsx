import { ApiClientError, type ApiClient } from "@template/api-client";
import type { Permission, SessionView } from "@template/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

/**
 * Screens get everything platform-specific through these contexts: the API client and
 * navigation. They never call `fetch` or read `window.location` themselves (`pnpm
 * check:boundaries`), so a desktop shell can provide its own and reuse every screen.
 */

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useApi must be used inside <ApiProvider>");
  return client;
}

export type Nav = {
  /** The current path, with its query string. */
  path: string;
  /** Moves within the app. */
  navigate(to: string, options?: { replace?: boolean }): void;
  /** Leaves the app (Google, an OAuth client's redirect). */
  openExternal(url: string): void;
};

const NavContext = createContext<Nav | null>(null);

export function NavProvider({ nav, children }: { nav: Nav; children: ReactNode }) {
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav must be used inside <NavProvider>");
  return nav;
}

/**
 * Navigates once, the first time `to` is a string (a signed-out person on a signed-in page, say).
 * While the router moves, the screen can render again with the new path, which would make a new
 * target (`returnTo` nesting itself); so it fires at most once per mount.
 */
export function useRedirect(to: string | null): void {
  const nav = useNav();
  const navRef = useRef(nav);
  navRef.current = nav;
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!to || done.current) return;
    done.current = to;
    navRef.current.navigate(to, { replace: true });
  }, [to]);
}

/** An in-app link: a real `<a href>` (so it opens in a new tab), navigating through `useNav`. */
export function Link({
  to,
  children,
  onClick,
  ...props
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const nav = useNav();
  return (
    <a
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        nav.navigate(to);
      }}
      {...props}
    >
      {children}
    </a>
  );
}

type SessionState = {
  /** Null until the first load finishes. */
  session: SessionView | null;
  error: unknown;
  refresh(): Promise<SessionView | null>;
  /**
   * Bumps when data changed somewhere other than the screen in front (the Assistant ran an
   * action). Screens that load their own data list it in their effect's dependencies.
   */
  dataVersion: number;
  /** Says data changed: re-reads the session and bumps `dataVersion`. */
  dataChanged(): Promise<void>;
  /**
   * Takes a session payload a call already returned (a switch, a new company, an accepted
   * invitation) without another round trip, and bumps `dataVersion`: everything on screen
   * belonged to the previous organization.
   */
  apply(view: SessionView): void;
};

const SessionContext = createContext<SessionState | null>(null);

/** Loads `GET /api/session` once (user, organization and sign-in methods in one call). */
export function SessionProvider({
  children,
  initial = null,
}: {
  children: ReactNode;
  /** A session already loaded (tests, server rendering). */
  initial?: SessionView | null;
}) {
  const api = useApi();
  const [session, setSession] = useState<SessionView | null>(initial);
  const [error, setError] = useState<unknown>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await api.session();
      setSession(next);
      setError(null);
      return next;
    } catch (failure) {
      setError(failure);
      return null;
    }
  }, [api]);
  useEffect(() => {
    if (!initial) void refresh();
  }, [initial, refresh]);
  const [dataVersion, setDataVersion] = useState(0);
  const dataChanged = useCallback(async () => {
    await refresh();
    setDataVersion((version) => version + 1);
  }, [refresh]);
  const apply = useCallback((view: SessionView) => {
    setSession(view);
    setError(null);
    setDataVersion((version) => version + 1);
  }, []);
  const value = useMemo(
    () => ({ session, error, refresh, dataVersion, dataChanged, apply }),
    [session, error, refresh, dataVersion, dataChanged, apply],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const state = useContext(SessionContext);
  if (!state) throw new Error("useSession must be used inside <SessionProvider>");
  return state;
}

/**
 * Whether the signed-in person may do something in the open organization (`GET /api/session`'s
 * `permissions`). Presentation only: it hides what they can't do; the server decides. Never
 * compare roles in a screen.
 */
export function useCan(permission: Permission): boolean {
  const { session } = useSession();
  return session?.permissions.includes(permission) ?? false;
}

/** A failure as the person reads it, with the request id to quote for an unexpected one. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === "internal" && error.requestId)
      return `${error.message} (Reference: ${error.requestId})`;
    return error.message;
  }
  return "Something went wrong. Try again.";
}

/**
 * Runs a form's submit: tracks `pending`, keeps per-field errors from `invalid_input`, and a
 * message for everything else. `run` returns whatever the action returns.
 */
export function useSubmit<A extends unknown[], R>(action: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      setFields({});
      try {
        return await action(...args);
      } catch (failure) {
        if (failure instanceof ApiClientError && Object.keys(failure.fields).length) {
          setFields(failure.fields);
          // Fields show their own messages; the form-level one is for the rest.
          const unshown = Object.keys(failure.fields).some(
            (key) => key === "_" || key.includes("."),
          );
          if (unshown) setError(failure.message);
        } else setError(errorMessage(failure));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [action],
  );
  return { run, pending, error, fields, setError };
}

/** A query string value from a path, for screens given `nav.path`. */
export function queryParam(path: string, name: string): string | null {
  const query = path.split("?")[1] ?? "";
  return new URLSearchParams(query).get(name);
}
