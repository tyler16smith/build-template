import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./context";

export type Loaded<T> = {
  data: T | null;
  /** True until the first load settles. */
  loading: boolean;
  error: unknown;
  refetch: () => Promise<void>;
  /**
   * Applies a write's result to the data shown, with no request: the record an action returned,
   * or a row it removed. Use it instead of `refetch` when the result says everything.
   */
  update: (change: (data: T | null) => T | null) => void;
};

/**
 * Loads `load()` on mount, again when `key` or the session's `dataVersion` changes, and every
 * `pollMs` while `shouldPoll(data)` holds (a run in progress, a connection waiting for its first
 * event). A failed refresh keeps the data already shown.
 */
export function useLoad<T>(
  load: (() => Promise<T>) | null,
  key: string,
  options: { pollMs?: number; shouldPoll?: (data: T | null) => boolean } = {},
): Loaded<T> {
  const { dataVersion } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(load));
  const loadRef = useRef(load);
  loadRef.current = load;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    const run = loadRef.current;
    if (!run) return;
    try {
      const next = await run();
      if (!live.current) return;
      setData(next);
      setError(null);
    } catch (failure) {
      if (live.current) setError(failure);
    } finally {
      if (live.current) setLoading(false);
    }
  }, []);

  const enabled = Boolean(load);
  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    setData(null);
    void refetch();
  }, [key, enabled, refetch]);

  useEffect(() => {
    if (enabled && dataVersion > 0) void refetch();
  }, [dataVersion, enabled, refetch]);

  const polling =
    enabled && Boolean(options.pollMs) && (options.shouldPoll ? options.shouldPoll(data) : true);
  useEffect(() => {
    if (!polling || !options.pollMs) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refetch();
    }, options.pollMs);
    return () => clearInterval(timer);
  }, [polling, options.pollMs, refetch]);

  const update = useCallback((change: (data: T | null) => T | null) => setData(change), []);

  return { data, loading, error, refetch, update };
}
