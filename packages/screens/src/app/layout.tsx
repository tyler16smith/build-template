import {
  AppearanceMenu,
  AppShell,
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  LoadingState,
  SidebarAction,
  toast,
  Toaster,
  type NavItemDef,
} from "@template/ui";
import { Building2, Home, LogOut, Mail, Settings, UserRound, Workflow } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { ORGANIZATION_NOUN, organizationLabel } from "../brand";
import {
  errorMessage,
  Link,
  queryParam,
  useApi,
  useNav,
  useRedirect,
  useSession,
} from "../context";
import { AskAiButton, AssistantProvider, AssistantSidebar } from "../assistant/assistant";
import { AppBrand, AppMark, OrganizationSwitcher } from "../organization/switcher";

/**
 * `?org=<organizationId>` on any page (an email about a job, an automation notice): opens that
 * organization first if the person belongs to it, else says they don't have access and stays.
 * Then the parameter goes, so a reload doesn't switch again.
 */
function useOrganizationLink() {
  const { session, apply } = useSession();
  const api = useApi();
  const nav = useNav();
  const handled = useRef<string | null>(null);
  const wanted = queryParam(nav.path, "org");
  const open = session?.profile?.organization?.id;
  useEffect(() => {
    if (!wanted || !session?.profile || handled.current === wanted) return;
    handled.current = wanted;
    const [path = "/", query = ""] = nav.path.split("?");
    const params = new URLSearchParams(query);
    params.delete("org");
    const rest = params.toString();
    const without = rest ? `${path}?${rest}` : path;
    if (wanted === open) {
      nav.navigate(without, { replace: true });
      return;
    }
    if (!session.organizations.some((o) => o.id === wanted)) {
      toast(`You don't have access to that ${ORGANIZATION_NOUN.one}`, { tone: "danger" });
      nav.navigate(without, { replace: true });
      return;
    }
    api.auth
      .switchOrganization(wanted)
      .then((view) => {
        apply(view);
        nav.navigate(without, { replace: true });
      })
      .catch((failure: unknown) =>
        toast(`Couldn't open that ${ORGANIZATION_NOUN.one}`, {
          description: errorMessage(failure),
          tone: "danger",
        }),
      );
  }, [wanted, open, session, api, apply, nav]);
}

/**
 * The signed-in frame: the app's logo and name at the top of the sidebar, the pages, and the
 * account menu at the bottom (the person, the open company, switching companies, dark mode).
 */
export function AppLayout({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const nav = useNav();
  const path = nav.path.split("?")[0] ?? "/";

  // Without a company, only the profile stays reachable (to sign out or delete the account).
  const profileOnly = path === "/profile";
  useRedirect(
    session && !session.profile
      ? `/sign-in?returnTo=${encodeURIComponent(nav.path)}`
      : // No company yet: they name one, or join one they're invited to.
        session?.profile && !session.profile.organization && !profileOnly
        ? `/onboarding?returnTo=${encodeURIComponent(nav.path)}`
        : null,
  );
  useOrganizationLink();

  const organization = session?.profile?.organization;
  if (session?.profile && !organization && profileOnly)
    return (
      <div className="min-h-dvh bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 pt-6">
          <Link to="/onboarding" className="text-sm font-medium text-primary hover:underline">
            {`Name your ${ORGANIZATION_NOUN.one}`}
          </Link>
          <AccountMenu />
        </div>
        {children}
        <Toaster />
      </div>
    );
  if (!session?.profile || !organization)
    return <LoadingState label="Loading" className="min-h-dvh" />;

  const items: NavItemDef[] = [
    { href: "/", label: "Home", icon: Home, active: path === "/" },
    {
      href: "/automations",
      label: "Automations",
      icon: Workflow,
      active: path === "/automations" || path.startsWith("/automations/"),
    },
    {
      href: "/settings/organization",
      label: "Settings",
      icon: Settings,
      active: path === "/profile" || path.startsWith("/settings/"),
    },
  ];

  return (
    <AssistantProvider>
      <AppShell
        brand={<AppBrand />}
        brandMark={<AppMark />}
        nav={items}
        onNavigate={(href, event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          nav.navigate(href);
        }}
        actions={<AccountMenu />}
        aside={<AssistantSidebar />}
      >
        {children}
        <AskAiButton />
        <Toaster />
      </AppShell>
    </AssistantProvider>
  );
}

function AccountMenu() {
  const { session, refresh } = useSession();
  const api = useApi();
  const nav = useNav();
  const profile = session?.profile;
  if (!profile) return null;
  const organization = profile.organization;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarAction
          icon={<Avatar name={profile.name} size="sm" />}
          label={profile.name}
          detail={organization?.name}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuLabel>
          <span className="block truncate">{profile.name}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {profile.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => nav.navigate("/profile")}>
          <UserRound /> Profile
        </DropdownMenuItem>
        {organization ? (
          <>
            <DropdownMenuItem onSelect={() => nav.navigate("/settings/organization")}>
              <Building2 /> {organizationLabel()} settings
            </DropdownMenuItem>
            <OrganizationSwitcher />
          </>
        ) : null}
        <AppearanceMenu />
        {/* Local only: nothing is sent, so the mail the app would have sent is read here. */}
        {session.environment === "local" ? (
          <DropdownMenuItem onSelect={() => nav.navigate("/dev/mail")}>
            <Mail /> Dev mail
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            void api.auth.signOut().then(async () => {
              await refresh();
              nav.navigate("/sign-in", { replace: true });
            })
          }
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
