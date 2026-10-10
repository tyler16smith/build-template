import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { useSyncExternalStore } from "react";
import { cn } from "../lib/cn";

type ToastTone = "info" | "success" | "danger";
/** A follow-up the person can take from the toast: a button (`onClick`) or a link (`href`). */
export type ToastAction = { label: string; onClick?: () => void; href?: string };
type ToastRecord = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
  actions?: ToastAction[];
  /** Stays until the person or the app dismisses it. */
  persistent?: boolean;
  onDismiss?: () => void;
};

let toasts: ToastRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** A toast with actions stays up longer, so there is time to read it and choose. */
const DURATION_MS = 5000;
const ACTION_DURATION_MS = 15000;

/** Shows a toast; returns its id for `dismissToast`. */
export function toast(
  title: string,
  options: {
    description?: string;
    tone?: ToastTone;
    actions?: ToastAction[];
    /** Keep it up until it's dismissed, for something the person still has to act on. */
    persistent?: boolean;
    /** Called when it goes away, however that happens. */
    onDismiss?: () => void;
  } = {},
): number {
  const id = nextId++;
  toasts = [
    ...toasts,
    {
      id,
      title,
      description: options.description,
      tone: options.tone ?? "info",
      actions: options.actions?.length ? options.actions : undefined,
      persistent: options.persistent,
      onDismiss: options.onDismiss,
    },
  ];
  emit();
  return id;
}
toast.success = (title: string, description?: string) =>
  toast(title, { description, tone: "success" });
toast.error = (title: string, description?: string) =>
  toast(title, { description, tone: "danger" });

/** Removes a toast; nothing happens if it's already gone. */
export function dismissToast(id: number) {
  const item = toasts.find((t) => t.id === id);
  if (!item) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
  item.onDismiss?.();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const icons = { info: Info, success: CheckCircle2, danger: AlertCircle };

/** Mount once near the root. Toasts are announced politely to screen readers. */
export function Toaster() {
  const items = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={DURATION_MS}>
      {items.map((item) => {
        const Icon = icons[item.tone];
        return (
          <ToastPrimitive.Root
            key={item.id}
            duration={item.persistent ? Infinity : item.actions ? ACTION_DURATION_MS : DURATION_MS}
            type={item.tone === "danger" ? "foreground" : "background"}
            onOpenChange={(open) => !open && dismissToast(item.id)}
            className={cn(
              "flex items-start gap-3 rounded-lg border border-border bg-surface-raised p-3 pr-2 text-sm shadow-lg animate-ui-slide-up",
              item.tone === "danger" && "border-danger/40",
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                item.tone === "success" && "text-success",
                item.tone === "danger" && "text-danger",
                item.tone === "info" && "text-info",
              )}
            />
            <div className="grid flex-1 gap-0.5">
              <ToastPrimitive.Title className="font-medium">{item.title}</ToastPrimitive.Title>
              {item.description ? (
                <ToastPrimitive.Description className="text-muted-foreground">
                  {item.description}
                </ToastPrimitive.Description>
              ) : null}
              {item.actions ? (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {item.actions.map((action) => (
                    <ToastPrimitive.Action key={action.label} altText={action.label} asChild>
                      {action.href ? (
                        <a
                          href={action.href}
                          target={action.href.startsWith("mailto:") ? undefined : "_blank"}
                          rel="noreferrer"
                          className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                        >
                          {action.label}
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={action.onClick}
                          className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                        >
                          {action.label}
                        </button>
                      )}
                    </ToastPrimitive.Action>
                  ))}
                </div>
              ) : null}
            </div>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="rounded p-1 text-muted-foreground hover:bg-muted"
            >
              <X aria-hidden className="size-3.5" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
