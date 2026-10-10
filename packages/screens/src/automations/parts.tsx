import { CopyButton, Field, Input } from "@template/ui";
import type { ReactNode } from "react";

/** A read-only value with a copy button: a URL, a header name, a secret shown once. */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <CopyInput label={label} value={value} />
    </Field>
  );
}

function CopyInput({
  label,
  value,
  ...aria
}: {
  label: string;
  value: string;
  id?: string;
  "aria-describedby"?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        readOnly
        value={value}
        className="min-w-0 font-mono text-xs"
        onFocus={(e) => e.target.select()}
        {...aria}
      />
      <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} className="shrink-0" />
    </div>
  );
}

/** A titled block of a page, below its `PageHeader`. */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
