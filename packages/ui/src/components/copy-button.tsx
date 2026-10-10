import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

/** Copies `text` and confirms with a check for a moment. */
export function CopyButton({
  text,
  label = "Copy",
  className,
  showLabel,
}: {
  text: string;
  label?: string;
  className?: string;
  /** Shows the label beside the icon instead of only to screen readers. */
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={showLabel ? undefined : copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      <Icon aria-hidden className={cn("size-3.5", copied && "text-success")} />
      {showLabel ? <span>{copied ? "Copied" : label}</span> : null}
    </button>
  );
}
