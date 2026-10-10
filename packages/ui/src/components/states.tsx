import { RefreshCw } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { Spinner } from "./spinner";

// Their own module, so a screen that only needs a loading or error state doesn't load the app
// shell and the command palette.
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong/40 px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? (
        <div className="mb-3 rounded-full bg-muted p-3">
          <Icon aria-hidden className="size-5 text-muted-foreground" />
        </div>
      ) : null}
      <h2 className="text-sm font-semibold">{title}</h2>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  error,
  onRetry,
  className,
}: {
  title?: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-danger/30 bg-danger-soft/30 px-6 py-10 text-center",
        className,
      )}
    >
      <h2 className="text-sm font-semibold text-danger">{title}</h2>
      {message ? <p className="mt-1 max-w-md text-sm text-muted-foreground">{message}</p> : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingState({
  label = "Loading",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground",
        className,
      )}
    >
      <Spinner label={label} />
      <span aria-hidden>{label}…</span>
    </div>
  );
}

export function PermissionState({
  title = "You don't have access",
  description,
}: {
  title?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted/40 px-6 py-12 text-center">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {description ?? "Ask an owner of your company to change your role if you need this."}
      </p>
    </div>
  );
}

/** Search box plus filter controls. Filters are passed as children (Selects, toggles, chips). */
