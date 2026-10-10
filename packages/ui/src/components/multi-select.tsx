import { Check, ChevronDown } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { forwardRef, useId, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { cn } from "../lib/cn";

export type MultiSelectOption = {
  value: string;
  label: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** Section heading. Options keep their order within a group. */
  group?: string;
};

export type MultiSelectProps = {
  value: string[];
  onValueChange: (value: string[]) => void;
  options: MultiSelectOption[];
  /**
   * Adds a first row with this label that stands for every option. An empty `value` means it
   * is chosen; picking it clears the others, and clearing the last option falls back to it.
   */
  allLabel?: string;
  /** Trigger text when nothing is chosen and there is no `allLabel`. */
  placeholder?: string;
  /** `field` matches the other form controls. `outline` is a compact, transparent trigger. */
  variant?: "field" | "outline";
  align?: "start" | "center" | "end";
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  /** Where focus goes when the list closes. Call `preventDefault` to move it yourself. */
  onCloseAutoFocus?: (event: Event) => void;
};

const ALL = "\u0000all";

type Row = { value: string; label: string; icon?: MultiSelectOption["icon"]; group?: string };

/** Summary for the trigger: the one choice, or the first choice and how many more. */
export function multiSelectSummary(
  value: string[],
  options: MultiSelectOption[],
  fallback: string,
): string {
  const chosen = options.filter((option) => value.includes(option.value));
  if (chosen.length === 0) return fallback;
  if (chosen.length === 1) return chosen[0]!.label;
  return `${chosen[0]!.label} +${chosen.length - 1}`;
}

/** Next value after toggling `picked`, honoring the `allLabel` rules. */
export function toggleMultiSelect(value: string[], picked: string, hasAll: boolean): string[] {
  if (hasAll && picked === ALL) return [];
  return value.includes(picked) ? value.filter((entry) => entry !== picked) : [...value, picked];
}

/**
 * Pick any number of options from a popover list. The list stays open while choices change,
 * so several can be toggled in a row. Wrap it in `Field` for its label.
 */
export const MultiSelect = forwardRef<HTMLButtonElement, MultiSelectProps>(function MultiSelect(
  {
    value,
    onValueChange,
    options,
    allLabel,
    placeholder = "Select…",
    variant = "field",
    align = "start",
    disabled = false,
    className,
    id,
    "aria-label": ariaLabel,
    onCloseAutoFocus,
  },
  ref,
) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const rows: Row[] = [...(allLabel ? [{ value: ALL, label: allLabel }] : []), ...options];
  const known = value.filter((entry) => options.some((option) => option.value === entry));
  const isChosen = (row: Row) =>
    row.value === ALL ? known.length === 0 : known.includes(row.value);
  const summary = multiSelectSummary(known, options, allLabel ?? placeholder);
  const single = known.length === 1 ? options.find((option) => option.value === known[0]) : null;
  const SummaryIcon = single?.icon;

  function toggle(row: Row) {
    onValueChange(toggleMultiSelect(known, row.value, Boolean(allLabel)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => Math.min(Math.max(current + delta, 0), rows.length - 1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : rows.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const row = rows[active];
      if (row) toggle(row);
    }
  }

  let previousGroup: string | undefined;

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          const first = rows.findIndex(isChosen);
          setActive(first >= 0 ? first : 0);
        }
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={ref}
          id={id}
          type="button"
          disabled={disabled}
          aria-label={ariaLabel ? `${ariaLabel}: ${summary}` : undefined}
          aria-haspopup="listbox"
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60",
            variant === "field"
              ? "h-9 w-full rounded-md border border-input bg-surface px-3 text-foreground shadow-sm"
              : "h-7 max-w-44 rounded-md border border-border-strong bg-transparent pl-2 pr-1.5 text-xs font-medium text-foreground hover:bg-muted/60 data-[state=open]:bg-muted/60",
            className,
          )}
        >
          {SummaryIcon ? (
            <SummaryIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              known.length === 0 && !allLabel && "text-muted-foreground/80",
            )}
          >
            {summary}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "shrink-0 text-muted-foreground transition-transform duration-150",
              variant === "field" ? "size-4" : "size-3.5",
              open && "rotate-180",
            )}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={6}
          align={align}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            listRef.current?.focus();
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            "z-50 max-w-72 overflow-hidden rounded-lg border border-border bg-surface-raised text-foreground shadow-lg animate-ui-fade-in focus:outline-none",
            variant === "field" ? "w-[var(--radix-popover-trigger-width)]" : "min-w-52",
          )}
        >
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-multiselectable
            aria-label={ariaLabel}
            tabIndex={-1}
            aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
            onKeyDown={onKeyDown}
            className="max-h-72 overflow-y-auto p-1 focus:outline-none"
          >
            {rows.map((row, index) => {
              const chosen = isChosen(row);
              const Icon = row.icon;
              const heading = row.group && row.group !== previousGroup ? row.group : null;
              const divider = row.value === ALL && rows.length > 1;
              previousGroup = row.group;
              return (
                <div key={row.value} role="presentation">
                  {heading ? (
                    <div
                      aria-hidden
                      className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground"
                    >
                      {heading}
                    </div>
                  ) : null}
                  <div
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={chosen}
                    ref={(node) => {
                      if (node && index === active) node.scrollIntoView({ block: "nearest" });
                    }}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => toggle(row)}
                    className={cn(
                      "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
                      index === active && "bg-muted",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors duration-100",
                        chosen
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border-strong bg-surface",
                      )}
                    >
                      {chosen ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    {Icon ? (
                      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  </div>
                  {divider ? <div aria-hidden className="-mx-1 my-1 h-px bg-border" /> : null}
                </div>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
});
