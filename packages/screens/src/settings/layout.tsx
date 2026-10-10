import { cn, PageHeader } from "@template/ui";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { organizationLabel } from "../brand";
import { Link, useNav } from "../context";

const SECTIONS = [
  { href: "/profile", label: "Profile" },
  { href: "/settings/organization", label: organizationLabel() },
  { href: "/settings/members", label: "Members" },
];

type Indicator = { left: number; width: number };

/**
 * Where the underline sat on the last settings page. Each settings route mounts its own layout,
 * so the next one slides the underline from here to its own tab.
 */
let lastIndicator: Indicator | null = null;

const frame = ({ left, width }: Indicator) => ({
  transform: `translateX(${left}px)`,
  width: `${width}px`,
});

/**
 * Settings pages share a "Settings" header and a row of tabs (Profile, Company, Members) with an
 * underline that slides to the current one. The tabs stick to the top as the page scrolls;
 * `description` and `actions` sit below them.
 */
export function SettingsLayout({
  description,
  actions,
  children,
}: {
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const nav = useNav();
  const path = nav.path.split("?")[0];
  const listRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  /** Moves the underline under the current tab, sliding it from `from` when given. */
  const place = (from: Indicator | null) => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const indicator = indicatorRef.current;
    if (!active || !indicator) return;
    const next = { left: active.offsetLeft, width: active.offsetWidth };
    lastIndicator = next;
    Object.assign(indicator.style, frame(next), { opacity: "1" });
    const moved = from && (from.left !== next.left || from.width !== next.width);
    if (moved && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      indicator.animate([frame(from), frame(next)], {
        duration: 300,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      });
  };

  // Before the first paint, so the underline never shows in the wrong place.
  useLayoutEffect(() => place(lastIndicator), [path]);

  useEffect(() => {
    const observer = new ResizeObserver(() => place(null));
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pb-6">
      <PageHeader title="Settings" className="pt-6 pb-4" />
      {/* A direct child of the page so it stays stuck below the mobile top bar (3.5rem) and any
          banner for the whole scroll. */}
      <div className="sticky top-[calc(var(--ui-banner-h,0px)+3.5rem)] z-20 -mx-6 bg-background px-6 md:top-shell">
        <span aria-hidden className="absolute inset-x-6 bottom-0 h-px bg-border" />
        <nav aria-label="Settings" className="relative overflow-x-auto">
          <div ref={listRef} className="relative flex w-max gap-1">
            {SECTIONS.map((section) => {
              const active = path === section.href;
              return (
                <Link
                  key={section.href}
                  to={section.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "shrink-0 rounded-sm px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {section.label}
                </Link>
              );
            })}
            <span
              ref={indicatorRef}
              aria-hidden
              className="absolute bottom-0 left-0 h-0.5 rounded-full bg-primary opacity-0"
            />
          </div>
        </nav>
      </div>
      <div className="grid min-w-0 content-start gap-6 pt-6">
        {description || actions ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            {description ? (
              <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
            ) : null}
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
