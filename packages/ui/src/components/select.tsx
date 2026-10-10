import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { forwardRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { controlBase } from "./form";

// Its own module, so screens that don't use a select (sign-in) don't load Radix Select.
export type SelectOption = { value: string; label: ReactNode; disabled?: boolean };

export const Select = forwardRef<
  HTMLButtonElement,
  {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    id?: string;
    "aria-label"?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }
>(
  (
    { options, placeholder, className, value, defaultValue, onValueChange, disabled, ...aria },
    ref,
  ) => (
    // Radix reports "" when the current value has no matching option yet (options still loading).
    // Items can never have an empty value, so "" is never a real choice and must not reach callers.
    <SelectPrimitive.Root
      value={defaultValue === undefined ? (value ?? "") : value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (next !== "") onValueChange?.(next);
      }}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        ref={ref}
        className={cn(
          controlBase,
          "flex h-9 min-w-0 items-center justify-between gap-2 overflow-hidden text-left [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:truncate",
          className,
        )}
        {...aria}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="shrink-0">
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        {/* Item-aligned: the list opens over the trigger with the chosen option on top of it,
            like a native pop-up button, rather than dropping below. */}
        <SelectPrimitive.Content
          position="item-aligned"
          className="z-50 overflow-hidden rounded-md border border-border bg-surface-raised text-foreground shadow-lg animate-ui-fade-in"
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 cursor-default items-center justify-center text-muted-foreground">
            <ChevronUp aria-hidden className="size-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm whitespace-nowrap outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2 inline-flex">
                  <Check aria-hidden className="size-4" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 cursor-default items-center justify-center text-muted-foreground">
            <ChevronDown aria-hidden className="size-4" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  ),
);
Select.displayName = "Select";
