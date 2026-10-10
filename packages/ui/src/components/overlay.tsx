import { ChevronRight, X } from "lucide-react";
import {
  Dialog as DialogPrimitive,
  DropdownMenu as MenuPrimitive,
  Popover as PopoverPrimitive,
} from "radix-ui";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  size = "md",
  hideTitle,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
  hideTitle?: boolean;
} & Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title">) {
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-overlay animate-ui-fade-in" />
      <DialogPrimitive.Content
        data-submit-scope=""
        className={cn(
          "fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-xl border border-border bg-surface-raised text-foreground shadow-lg animate-ui-slide-up focus:outline-none",
          width,
          className,
        )}
        {...props}
      >
        <div
          className={cn(
            "flex items-start justify-between gap-4 border-b border-border px-5 py-4",
            hideTitle && "sr-only",
          )}
        >
          <div className="grid gap-1">
            <DialogPrimitive.Title className="text-base font-semibold leading-tight">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-sm text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Close"
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mt-5 flex flex-wrap items-center justify-end gap-2", className)}>
      {children}
    </div>
  );
}

/** Gap between a side panel and the viewport edges. Panels are rounded, not flush to the corners. */
export const SHEET_INSET_PX = 5;

export type SheetSide = "left" | "right";

/**
 * Overlay side panel. Slides in from `side`, 5px off the screen edges, with rounded corners.
 * `className` can replace the width (`w-64`) or the fill (`bg-surface`).
 */
export function sheetPanelClass(side: SheetSide = "right", className?: string): string {
  return cn(
    "fixed top-[5px] bottom-[5px] z-50 flex w-[calc(100%-10px)] max-w-md flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg focus:outline-none",
    side === "left"
      ? "left-[5px] data-[state=open]:animate-ui-slide-in-left data-[state=closed]:animate-ui-slide-out-left"
      : "right-[5px] data-[state=open]:animate-ui-slide-in-right data-[state=closed]:animate-ui-slide-out-right",
    className,
  );
}

/** The sliding frame around a side panel. Put a `Dialog` title in `children`, or pass `label`. */
export function SheetFrame({
  side = "right",
  label,
  className,
  children,
  ...props
}: {
  side?: SheetSide;
  /** Accessible name when `children` does not include a dialog title. */
  label?: string;
  className?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "children">) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-overlay data-[state=open]:animate-ui-fade-in data-[state=closed]:animate-ui-fade-out" />
      <DialogPrimitive.Content
        {...props}
        {...(label ? { "aria-describedby": undefined } : {})}
        data-submit-scope=""
        className={sheetPanelClass(side, className)}
      >
        {label ? <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title> : null}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * A dialog anchored to the left or right edge; used for side panels such as the Assistant. The
 * body scrolls and is padded to line up with the header. Pass `flush` to lay out the body edge to
 * edge yourself, for example with a pinned footer or a chat.
 */
export function SheetContent({
  title,
  description,
  children,
  className,
  side = "right",
  flush = false,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  side?: SheetSide;
  flush?: boolean;
} & Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title">) {
  return (
    <SheetFrame side={side} className={className} {...props}>
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="grid min-w-0 gap-0.5">
          <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description
            className={cn("text-sm text-muted-foreground", !description && "sr-only")}
          >
            {description ?? title}
          </DialogPrimitive.Description>
        </div>
        <DialogPrimitive.Close
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Close"
        >
          <X aria-hidden className="size-4" />
        </DialogPrimitive.Close>
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", !flush && "overflow-y-auto px-5 py-4")}>
        {children}
      </div>
    </SheetFrame>
  );
}

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuSub = MenuPrimitive.Sub;

export const DropdownMenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <MenuPrimitive.Portal>
    <MenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-44 overflow-hidden rounded-md border border-border bg-surface-raised p-1 text-foreground shadow-lg animate-ui-fade-in",
        className,
      )}
      {...props}
    />
  </MenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground",
      destructive && "text-danger [&_svg]:text-danger",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <MenuPrimitive.Label className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </MenuPrimitive.Label>
  );
}

export function DropdownMenuSeparator() {
  return <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}

export const DropdownMenuSubTrigger = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <MenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[state=open]:bg-muted [&_svg]:size-4",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight aria-hidden className="ml-auto size-4 shrink-0 text-muted-foreground" />
  </MenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Portal>
    <MenuPrimitive.SubContent
      ref={ref}
      className={cn(
        "z-50 min-w-40 rounded-md border border-border bg-surface-raised p-1 shadow-lg",
        className,
      )}
      {...props}
    />
  </MenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, sideOffset = 6, align = "start", ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={cn(
        "z-50 w-72 rounded-lg border border-border bg-surface-raised p-3 text-foreground shadow-lg animate-ui-fade-in focus:outline-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";

// Tooltip and InfoTip live in tooltip.tsx, so a form doesn't load menus and dialogs.
export { InfoTip, Tooltip } from "./tooltip";
