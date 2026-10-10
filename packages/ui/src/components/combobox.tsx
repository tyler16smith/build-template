import { Check, ChevronDown, X } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

const controlClass =
  "w-full rounded-md border border-input bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground/80 shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger";

export type ComboboxOption = {
  value: string;
  /** Visible text. Also searched. */
  label: string;
  /** Extra strings that match the query, such as a code already shown in the label. */
  keywords?: string[];
  disabled?: boolean;
  /** Section heading. Options keep their order within a group. */
  group?: string;
};

/** Prefix matches rank above substring matches. An empty query returns every option, in order. */
export function filterComboboxOptions(options: ComboboxOption[], query: string): ComboboxOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options
    .map((option, index) => ({ option, index, score: matchScore(option, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.option);
}

function matchScore(option: ComboboxOption, needle: string): number {
  const fields = [option.label, ...(option.keywords ?? [])];
  let best = 0;
  for (const field of fields) {
    const text = field.toLowerCase();
    if (text.startsWith(needle)) best = Math.max(best, 2);
    else if (text.includes(needle)) best = Math.max(best, 1);
  }
  return best;
}

type OptionGroup = { group?: string; options: ComboboxOption[] };

function groupInOrder(options: ComboboxOption[]): OptionGroup[] {
  const groups: OptionGroup[] = [];
  for (const option of options) {
    const group = option.group || undefined;
    const existing = groups.find((entry) => entry.group === group);
    if (existing) existing.options.push(option);
    else groups.push({ group, options: [option] });
  }
  return groups;
}

function firstEnabled(options: ComboboxOption[], preferValue?: string | null): number {
  if (preferValue) {
    const selected = options.findIndex((option) => option.value === preferValue);
    if (selected >= 0) return selected;
  }
  const enabled = options.findIndex((option) => !option.disabled);
  return enabled >= 0 ? enabled : 0;
}

function isTypingKey(event: KeyboardEvent<HTMLInputElement>): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

export type ComboboxProps = {
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  options: ComboboxOption[];
  placeholder?: string;
  /** Shown when the query matches nothing. */
  empty?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

/**
 * A text field that filters a list of options. Closed, it shows the chosen label. Open, the
 * field is the query, so typing filters immediately. Wrap it in `Field` for its label.
 */
export const Combobox = forwardRef<HTMLInputElement, ComboboxProps>(function Combobox(
  {
    value = null,
    onValueChange,
    options,
    placeholder = "Select…",
    empty = "No matches",
    disabled = false,
    autoFocus,
    className,
    id,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
  },
  ref,
) {
  const listId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLElement>());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const selected = options.find((option) => option.value === value) ?? null;
  const listed = filterComboboxOptions(options, open ? query : "");
  const listedRef = useRef(listed);
  listedRef.current = listed;
  const activeIndex = listed.length === 0 ? -1 : Math.min(active, listed.length - 1);
  const activeOption = activeIndex >= 0 ? listed[activeIndex] : undefined;
  const activeValue = activeOption?.value;

  useEffect(() => {
    if (!open || !activeValue) return;
    const frame = requestAnimationFrame(() => {
      optionRefs.current.get(activeValue)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, activeValue, query]);

  function setInput(node: HTMLInputElement | null) {
    inputRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }

  function openList(initialQuery = "") {
    const filtered = filterComboboxOptions(options, initialQuery);
    setQuery(initialQuery);
    setActive(firstEnabled(filtered, initialQuery.trim() ? null : value));
    setOpen(true);
    inputRef.current?.focus();
  }

  function closeList() {
    setOpen(false);
    setQuery("");
  }

  function choose(option: ComboboxOption) {
    if (option.disabled) return;
    onValueChange?.(option.value);
    closeList();
    inputRef.current?.focus();
  }

  function move(delta: 1 | -1) {
    const items = listedRef.current;
    if (items.length === 0 || activeIndex < 0) return;
    let index = activeIndex;
    for (let step = 0; step < items.length; step += 1) {
      index += delta;
      if (index < 0 || index >= items.length) return;
      if (!items[index]?.disabled) {
        setActive(index);
        return;
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openList();
      else move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      closeList();
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      if (activeOption && !activeOption.disabled) choose(activeOption);
      return;
    }
    if (event.key === "Tab") {
      if (open) closeList();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && value && (!open || query === "")) {
      event.preventDefault();
      onValueChange?.(null);
      return;
    }
    if (!open && isTypingKey(event)) {
      event.preventDefault();
      openList(event.key);
    }
  }

  let optionIndex = -1;
  const groups = groupInOrder(listed);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeList();
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <div ref={anchorRef} className="relative w-full">
          <input
            ref={setInput}
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && activeOption ? optionDomId(listId, activeIndex) : undefined
            }
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid || undefined}
            autoFocus={autoFocus}
            disabled={disabled}
            // Closed, the field shows the chosen label. It stays read-only so the next
            // character starts a query instead of appending to that label.
            readOnly={!open}
            autoComplete="off"
            spellCheck={false}
            placeholder={open && selected ? selected.label : placeholder}
            value={open ? query : (selected?.label ?? "")}
            onChange={(event) => {
              if (!open) return;
              const next = event.target.value;
              const filtered = filterComboboxOptions(options, next);
              setQuery(next);
              setActive(firstEnabled(filtered, next.trim() ? null : value));
            }}
            onMouseDown={() => {
              if (!disabled && !open) openList();
            }}
            onKeyDown={onKeyDown}
            className={cn(controlClass, "h-9 truncate", value ? "pr-16" : "pr-9", className)}
          />
          <div className="absolute inset-y-0 right-0.5 flex items-center">
            {value ? (
              <IconButton label="Clear" disabled={disabled} onClick={() => onValueChange?.(null)}>
                <X aria-hidden className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton
              label={open ? "Hide options" : "Show options"}
              disabled={disabled}
              onClick={() => {
                if (open) closeList();
                else openList();
                inputRef.current?.focus();
              }}
            >
              <ChevronDown aria-hidden className="size-4" />
            </IconButton>
          </div>
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={4}
          align="start"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            const target = event.target;
            if (target instanceof Node && anchorRef.current?.contains(target))
              event.preventDefault();
          }}
          className="z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-md border border-border bg-surface-raised text-foreground shadow-lg animate-ui-fade-in focus:outline-none"
        >
          <div className="max-h-72 overflow-y-auto p-1">
            {listed.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">{empty}</p>
            ) : (
              <div id={listId} role="listbox">
                {groups.map((group) => {
                  const items = group.options.map((option) => {
                    optionIndex += 1;
                    const index = optionIndex;
                    const highlighted = index === activeIndex;
                    return (
                      <div
                        key={option.value}
                        id={optionDomId(listId, index)}
                        role="option"
                        aria-selected={highlighted}
                        aria-disabled={option.disabled || undefined}
                        ref={(node) => {
                          if (node) optionRefs.current.set(option.value, node);
                          else optionRefs.current.delete(option.value);
                        }}
                        onMouseEnter={() => {
                          if (!option.disabled) setActive(index);
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          choose(option);
                        }}
                        className={cn(
                          "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm outline-none",
                          highlighted && "bg-muted",
                          option.disabled && "pointer-events-none opacity-50",
                        )}
                      >
                        {option.value === value ? (
                          <Check aria-hidden className="absolute left-2 size-4" />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      </div>
                    );
                  });
                  if (!group.group) {
                    return (
                      <div key="ungrouped" role="presentation">
                        {items}
                      </div>
                    );
                  }
                  return (
                    <div key={group.group} role="group" aria-label={group.group}>
                      <div
                        aria-hidden
                        className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground"
                      >
                        {group.group}
                      </div>
                      {items}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
});

function optionDomId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}
