import type { ClientErrorReport } from "@template/contracts";
import { ErrorState } from "@template/ui";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { api } from "./api";

/**
 * Browser errors go to `POST /api/client-errors`, where the server logs them through the same
 * redacting logger (`source: "browser"`). Never with a query string, and at most a few per page
 * view, so a render loop can't flood it. `screens` and `ui` don't call `fetch`, so this lives here.
 */
const MAX_REPORTS_PER_PAGE = 5;
let sent = 0;
const seen = new Set<string>();

export function reportError(kind: ClientErrorReport["kind"], error: unknown): void {
  if (sent >= MAX_REPORTS_PER_PAGE) return;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const key = `${kind}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  sent++;
  const stack = error instanceof Error ? error.stack?.slice(0, 4000) : undefined;
  const requestId =
    error &&
    typeof error === "object" &&
    typeof (error as { requestId?: unknown }).requestId === "string"
      ? (error as { requestId: string }).requestId
      : undefined;
  void api
    .reportError({ kind, message, stack, path: window.location.pathname, requestId })
    .catch(() => undefined);
}

export function installErrorReporter(): void {
  window.addEventListener("error", (event) => reportError("error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) =>
    reportError("unhandledrejection", event.reason),
  );
}

/** The React error boundary around every route: reports the error and offers a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo) {
    reportError("react", error);
  }

  override render() {
    if (this.state.error)
      return (
        <div className="grid min-h-dvh place-items-center p-6">
          <ErrorState
            title="This page hit a problem"
            error={new Error("We've been told about it. Reload to try again.")}
            onRetry={() => window.location.reload()}
          />
        </div>
      );
    return this.props.children;
  }
}
