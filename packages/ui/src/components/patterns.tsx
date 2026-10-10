import { Menu, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, X } from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import { Button, type ButtonProps } from "./button";
import { CommandPalette, commandModifier, type CommandItem, type CommandScopes } from "./command";
import { Avatar, Kbd } from "./display";
import { Dialog, SheetFrame, Tooltip } from "./overlay";
import { Spinner } from "./spinner";

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-4 pb-5", className)}>
      <div className="grid min-w-0 gap-1">
        {breadcrumbs ? (
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            {breadcrumbs}
          </nav>
        ) : null}
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export type NavItemDef = {
  href: string;
  label: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  active?: boolean;
  badge?: ReactNode;
  /** Section heading. Consecutive items with the same group render under one label. */
  group?: string;
};

const SIDEBAR_KEY = "ui-sidebar-collapsed";

function readCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(SIDEBAR_KEY) === "1";
}

type AppShellControls = {
  openNav: () => void;
  openSearch: () => void;
  searchShortcut: string;
};

const AppShellControlsContext = createContext<AppShellControls | null>(null);

/** Mobile menu and search, for a page that replaces the shell's top bar. */
export function useAppShellControls(): AppShellControls | null {
  return useContext(AppShellControlsContext);
}

const SidebarRailContext = createContext(false);

/**
 * True while `AppShell`'s `actions` render in the collapsed rail, which is only wide enough
 * for icon buttons: drop a button's text and give it a `Tooltip` instead.
 */
export function useSidebarRail(): boolean {
  return useContext(SidebarRailContext);
}

/**
 * A button for `AppShell`'s `actions`: full width with its label while the sidebar is open,
 * the icon alone with a tooltip to its right in the collapsed rail. Works as a menu trigger (`asChild`).
 */
export const SidebarAction = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "size" | "asChild"> & {
    icon: ReactNode;
    label: string;
    /** A second, quieter line under the label while the sidebar is open, such as the company. */
    detail?: string;
    /** Shown at the end of the row while the sidebar is open, such as a chevron. */
    trailing?: ReactNode;
    /** Unread items: a count at the end of the row, or a dot on the icon in the rail. */
    count?: number;
  }
>(({ icon, label, detail, trailing, count = 0, variant = "ghost", className, ...props }, ref) => {
  const rail = useSidebarRail();
  if (rail) {
    return (
      <Tooltip content={label} side="right">
        <Button
          ref={ref}
          variant={variant}
          size="icon-sm"
          aria-label={label}
          className={cn("relative", className)}
          {...props}
        >
          {icon}
          {count > 0 ? (
            <span
              aria-hidden
              className="absolute right-0.5 top-0.5 size-2 rounded-full bg-danger ring-2 ring-surface"
            />
          ) : null}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Button
      ref={ref}
      variant={variant}
      size="sm"
      className={cn("w-full justify-start px-2", detail && "h-auto py-1.5", className)}
      {...props}
    >
      {icon}
      {detail ? (
        <span className="grid min-w-0 flex-1 text-left leading-tight">
          <span className="truncate">{label}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{detail}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      )}
      {count > 0 ? (
        <span
          aria-hidden
          className="grid min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-semibold leading-5 text-white dark:text-black"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
      {trailing}
    </Button>
  );
});
SidebarAction.displayName = "SidebarAction";

export type AppShellSearch = {
  /** Actions, shown with the pages taken from `nav`. Filtered as the person types. */
  items?: CommandItem[];
  /** Records already matched to the current query. */
  results?: CommandItem[];
  loading?: boolean;
  onQueryChange?: (query: string) => void;
  placeholder?: string;
  /** Adds a picker, in place of the search icon, for searching other apps too. */
  scopes?: CommandScopes;
};

/**
 * Standard application frame: a collapsible sidebar with primary navigation and, at its foot,
 * the app's actions (New, notifications, theme, account), beside a full-height main region.
 * Small screens get a slim top bar that opens the sidebar as a drawer. The drawer slides in from
 * the left, 5px in from the screen, with rounded corners — the same side panel as `SheetContent`.
 * Includes a skip link so keyboard users can bypass navigation.
 * Search all (⌘K) covers the pages in `nav` plus anything passed in `search`.
 */
export function AppShell({
  brand,
  brandMark,
  nav,
  footer,
  actions,
  topbar,
  aside,
  search,
  children,
  onNavigate,
  sidebarCollapsed = false,
  hideTopbar = false,
  banner,
}: {
  brand: ReactNode;
  /** Logo alone, shown in the collapsed rail. Hovering it offers to open the panel. */
  brandMark?: ReactNode;
  nav: NavItemDef[];
  footer?: ReactNode;
  /**
   * Controls such as New, notifications, theme and account, in a row at the bottom of the
   * sidebar. In the collapsed rail they stack; see `useSidebarRail`.
   */
  actions?: ReactNode;
  /** @deprecated The top bar is gone; pass these as `actions`. */
  topbar?: ReactNode;
  /** A sibling of the page, not an overlay. Used for the Assistant sidebar. */
  aside?: ReactNode;
  search?: AppShellSearch;
  children: ReactNode;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Collapse the sidebar while this is set. Opening it again lasts only until this turns off,
   * and neither change is remembered.
   */
  sidebarCollapsed?: boolean;
  /** Leave the small-screen top bar out so the page can supply its own. */
  hideTopbar?: boolean;
  /**
   * A strip across the top, such as a preview notice. It takes its height out of the screen
   * rather than pushing the shell down; full-height panes use `h-shell` and `top-shell`.
   */
  banner?: ReactNode;
}) {
  const shellActions = actions ?? topbar;
  const [open, setOpen] = useState(false);
  const [storedCollapsed, setStoredCollapsed] = useState(readCollapsed);
  const [heldOpen, setHeldOpen] = useState(false);
  const [pinning, setPinning] = useState(sidebarCollapsed);
  if (sidebarCollapsed !== pinning) {
    setPinning(sidebarCollapsed);
    setHeldOpen(false);
  }
  const collapsed = sidebarCollapsed ? !heldOpen : storedCollapsed;
  const setCollapsed = (next: boolean) => {
    if (sidebarCollapsed) setHeldOpen(!next);
    else setStoredCollapsed(next);
  };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const shortcut = `${commandModifier()}K`;
  const bannerRef = useRef<HTMLDivElement>(null);
  const [bannerHeight, setBannerHeight] = useState(0);

  useEffect(() => {
    const node = bannerRef.current;
    if (!node) {
      setBannerHeight(0);
      return;
    }
    const measure = () => setBannerHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [banner]);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SIDEBAR_KEY, storedCollapsed ? "1" : "0");
  }, [storedCollapsed]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const closeDrawer = () => {
      if (query.matches) setOpen(false);
    };
    query.addEventListener("change", closeDrawer);
    return () => query.removeEventListener("change", closeDrawer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      } else if (event.key === "\\") {
        const target = event.target;
        const typing =
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
        if (typing) return;
        event.preventDefault();
        if (sidebarCollapsed) setHeldOpen((current) => !current);
        else setStoredCollapsed((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarCollapsed]);

  const commands: CommandItem[] = [
    ...nav.map((item) => ({
      id: `page:${item.href}`,
      group: "Pages",
      label: item.label,
      icon: item.icon,
      href: item.href,
    })),
    ...(search?.items ?? []),
  ];

  return (
    <AppShellControlsContext.Provider
      value={{
        openNav: () => setOpen(true),
        openSearch: () => setPaletteOpen(true),
        searchShortcut: shortcut,
      }}
    >
      <div
        className="min-h-dvh bg-background"
        style={{ "--ui-banner-h": `${bannerHeight}px` } as CSSProperties}
      >
        {banner ? (
          <div ref={bannerRef} className="sticky top-0 z-40">
            {banner}
          </div>
        ) : null}
        <div className="flex min-h-shell">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-lg"
          >
            Skip to content
          </a>
          <aside
            className={cn(
              "ui-side-panel-width sticky top-shell hidden h-shell shrink-0 flex-col self-start p-[5px] md:flex",
              collapsed ? "w-[calc(3.5rem+10px)]" : "w-[calc(15rem+10px)]",
            )}
          >
            <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
              {collapsed ? (
                <div className="flex h-14 border-b border-border">
                  <Tooltip content="Open panel" side="right">
                    <button
                      type="button"
                      aria-label="Open panel"
                      aria-expanded={false}
                      aria-keyshortcuts="Meta+\\ Control+\\"
                      onClick={() => setCollapsed(false)}
                      className="group relative grid h-full w-full place-items-center focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    >
                      {brandMark ? (
                        <>
                          <span className="transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0">
                            {brandMark}
                          </span>
                          <PanelLeftOpen
                            aria-hidden
                            className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                          />
                        </>
                      ) : (
                        <PanelLeftOpen aria-hidden className="size-4" />
                      )}
                    </button>
                  </Tooltip>
                </div>
              ) : (
                <div className="flex h-14 items-stretch border-b border-border pl-3">
                  <div className="flex min-w-0 flex-1 items-center">{brand}</div>
                  <Tooltip content="Close panel">
                    <button
                      type="button"
                      aria-label="Close panel"
                      aria-expanded
                      aria-keyshortcuts="Meta+\\ Control+\\"
                      onClick={() => setCollapsed(true)}
                      className="mr-5 grid h-full w-8 shrink-0 place-items-center text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    >
                      <PanelLeftClose aria-hidden className="size-4" />
                    </button>
                  </Tooltip>
                </div>
              )}
              {collapsed ? null : (
                <div className="px-3 pt-3">
                  <SearchTrigger shortcut={shortcut} onClick={() => setPaletteOpen(true)} />
                </div>
              )}
              <nav
                aria-label="Primary"
                className={cn("flex-1 overflow-y-auto", collapsed ? "p-2" : "p-3")}
              >
                {collapsed ? (
                  <div className="mb-1 flex justify-center">
                    <Tooltip content={`Search ${shortcut}`} side="right">
                      <button
                        type="button"
                        aria-label={`Search all (${shortcut})`}
                        aria-keyshortcuts="Meta+K Control+K"
                        onClick={() => setPaletteOpen(true)}
                        className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Search aria-hidden className="size-4" />
                      </button>
                    </Tooltip>
                  </div>
                ) : null}
                <NavLinks
                  idPrefix="sidebar"
                  nav={nav}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                  onPick={() => setOpen(false)}
                />
              </nav>
              {footer && !collapsed ? (
                <div className={cn("border-t border-border px-3 pt-3", !shellActions && "pb-3")}>
                  {footer}
                </div>
              ) : null}
              {shellActions ? (
                <div
                  className={cn(
                    !(footer && !collapsed) && "border-t border-border",
                    collapsed ? "flex flex-col items-center gap-1 p-2" : "flex flex-col gap-1 p-3",
                  )}
                >
                  <SidebarRailContext.Provider value={collapsed}>
                    {shellActions}
                  </SidebarRailContext.Provider>
                </div>
              ) : null}
            </div>
          </aside>
          <Dialog open={open} onOpenChange={setOpen}>
            <SheetFrame
              side="left"
              label="Navigation"
              className="w-64 max-w-[calc(100%-10px)] bg-surface"
            >
              <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-3">
                <div className="min-w-0 flex-1">{brand}</div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close navigation"
                  onClick={() => setOpen(false)}
                >
                  <X />
                </Button>
              </div>
              <div className="px-3 pt-3">
                <SearchTrigger
                  shortcut={shortcut}
                  onClick={() => {
                    setOpen(false);
                    setPaletteOpen(true);
                  }}
                />
              </div>
              <nav aria-label="Primary" className="flex-1 overflow-y-auto p-3">
                <NavLinks
                  idPrefix="drawer"
                  nav={nav}
                  collapsed={false}
                  onNavigate={onNavigate}
                  onPick={() => setOpen(false)}
                />
              </nav>
              {footer ? (
                <div className={cn("border-t border-border px-3 pt-3", !shellActions && "pb-3")}>
                  {footer}
                </div>
              ) : null}
              {shellActions ? (
                <div className={cn("flex flex-col gap-1 p-3", !footer && "border-t border-border")}>
                  {shellActions}
                </div>
              ) : null}
            </SheetFrame>
          </Dialog>
          <div className="flex min-w-0 flex-1 flex-col">
            {hideTopbar ? null : (
              <div className="sticky top-shell z-30 flex h-14 items-center gap-1 border-b border-border bg-surface/90 px-4 backdrop-blur md:hidden">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open navigation"
                  onClick={() => setOpen(true)}
                >
                  <Menu />
                </Button>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Search all (${shortcut})`}
                  aria-keyshortcuts="Meta+K Control+K"
                  onClick={() => setPaletteOpen(true)}
                >
                  <Search />
                </Button>
              </div>
            )}
            <main
              id="main"
              tabIndex={-1}
              className="min-w-0 flex-1 pb-20 focus:outline-none has-[[data-fill-screen]]:pb-0"
            >
              {children}
            </main>
          </div>
          {aside}
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            items={commands}
            results={search?.results}
            loading={search?.loading}
            onQueryChange={search?.onQueryChange}
            onNavigate={onNavigate}
            placeholder={search?.placeholder}
            scopes={search?.scopes}
            defaultQuery=""
          />
        </div>
      </div>
    </AppShellControlsContext.Provider>
  );
}

function SearchTrigger({ shortcut, onClick }: { shortcut: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-surface px-2.5 text-sm text-muted-foreground shadow-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
    >
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="flex-1 text-left">Search all</span>
      <Kbd>{shortcut}</Kbd>
    </button>
  );
}

function navSections(nav: NavItemDef[]): { group?: string; items: NavItemDef[] }[] {
  const sections: { group?: string; items: NavItemDef[] }[] = [];
  for (const item of nav) {
    const group = item.group || undefined;
    const last = sections.at(-1);
    if (last && last.group === group) last.items.push(item);
    else sections.push({ group, items: [item] });
  }
  return sections;
}

function NavLinks({
  idPrefix,
  nav,
  collapsed,
  onNavigate,
  onPick,
}: {
  idPrefix: string;
  nav: NavItemDef[];
  collapsed: boolean;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  onPick: () => void;
}) {
  const sections = navSections(nav);
  const grouped = sections.some((section) => section.group);
  return (
    <div className={cn(grouped && (collapsed ? "grid gap-2" : "grid gap-4"))}>
      {sections.map((section, index) => {
        const headingId = section.group ? `${idPrefix}-nav-group-${index}` : undefined;
        return (
          <div key={headingId ?? "nav"}>
            {section.group && !collapsed ? (
              <p
                id={headingId}
                className="px-2.5 pb-1 text-sm font-medium text-muted-foreground/70"
              >
                {section.group}
              </p>
            ) : null}
            <ul
              aria-labelledby={collapsed ? undefined : headingId}
              className={cn("grid gap-0.5", collapsed && "justify-items-center")}
            >
              {section.items.map((item) => {
                const Icon = item.icon;
                const link = (
                  <a
                    href={item.href}
                    aria-current={item.active ? "page" : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    onClick={(event) => {
                      onPick();
                      onNavigate?.(item.href, event);
                    }}
                    className={cn(
                      "rounded-md text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                      collapsed
                        ? "grid size-9 place-items-center"
                        : "flex items-center gap-2.5 px-2.5 py-1.5",
                      item.active && "bg-primary/10 text-foreground dark:bg-primary/20",
                    )}
                  >
                    {Icon ? (
                      <Icon aria-hidden className={cn("size-4", item.active && "text-primary")} />
                    ) : null}
                    {collapsed ? null : <span className="flex-1 truncate">{item.label}</span>}
                    {collapsed ? null : item.badge}
                  </a>
                );
                return (
                  <li key={item.href}>
                    {collapsed ? (
                      <Tooltip content={item.label} side="right">
                        {link}
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// EmptyState, ErrorState, LoadingState and PermissionState live in states.tsx.
export { EmptyState, ErrorState, LoadingState, PermissionState } from "./states";

export function FilterBar({
  query,
  onQueryChange,
  placeholder = "Search",
  children,
  activeCount = 0,
  onClear,
  className,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  placeholder?: string;
  children?: ReactNode;
  activeCount?: number;
  onClear?: () => void;
  className?: string;
}) {
  return (
    <div role="search" className={cn("flex flex-wrap items-center gap-2", className)}>
      <label className="relative min-w-52 flex-1 sm:max-w-72">
        <span className="sr-only">{placeholder}</span>
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          className="h-9 w-full rounded-md border border-input bg-surface pl-8 pr-3 text-sm shadow-sm placeholder:text-muted-foreground/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        />
      </label>
      {children}
      {activeCount > 0 && onClear ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X /> Clear filters ({activeCount})
        </Button>
      ) : null}
    </div>
  );
}

export function ActivityItem({
  actorName,
  summary,
  timestamp,
  channel,
  className,
}: {
  actorName: string | null;
  summary: ReactNode;
  timestamp: string;
  channel?: string;
  className?: string;
}) {
  const date = new Date(timestamp);
  return (
    <li className={cn("flex gap-3 py-2.5", className)}>
      <Avatar name={actorName ?? "System"} size="sm" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="leading-snug">
          <span className="font-medium">{actorName ?? "System"}</span>{" "}
          <span className="text-muted-foreground">{summary}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <time dateTime={timestamp}>{formatRelative(date)}</time>
          {channel && channel !== "browser" ? (
            <span> · via {channel === "mcp" ? "MCP" : channel}</span>
          ) : null}
        </p>
      </div>
    </li>
  );
}

export function formatRelative(date: Date, now = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), "day");
  return date.toLocaleDateString();
}
