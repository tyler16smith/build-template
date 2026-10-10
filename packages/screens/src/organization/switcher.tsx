import {
  Badge,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSeparator,
  toast,
} from "@template/ui";
import { ArrowLeftRight, Check, Plus } from "lucide-react";
import { APP_NAME, initials, ORGANIZATION_NOUN } from "../brand";
import { errorMessage, useApi, useNav, useSession } from "../context";

/** The company's initials, beside its name. */
export function OrganizationMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground"
    >
      {initials(name)}
    </span>
  );
}

/** The app's logo, as the sidebar's mark (and alone in the collapsed rail). */
export function AppMark() {
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
    >
      {APP_NAME.slice(0, 1)}
    </span>
  );
}

/** The top of the sidebar: the app's logo and name. */
export function AppBrand() {
  return (
    <span className="flex min-w-0 items-center gap-2 px-1">
      <AppMark />
      <span className="min-w-0 truncate font-semibold text-foreground">{APP_NAME}</span>
    </span>
  );
}

/**
 * For the account menu: every organization the person belongs to (most recently opened first)
 * with their role and a check on the open one, then Create company. It shows with one
 * organization too, since Create company lives here.
 */
export function OrganizationSwitcher() {
  const { session, apply } = useSession();
  const api = useApi();
  const nav = useNav();
  const open = session?.profile?.organization;
  if (!open) return null;
  const switchTo = async (organizationId: string) => {
    try {
      const view = await api.auth.switchOrganization(organizationId);
      apply(view);
      nav.navigate("/", { replace: true });
    } catch (failure) {
      toast(`Couldn't switch ${ORGANIZATION_NOUN.many}`, {
        description: errorMessage(failure),
        tone: "danger",
      });
    }
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <ArrowLeftRight className="text-muted-foreground" />
        <span className="flex-1">Switch {ORGANIZATION_NOUN.one}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {session.organizations.map((organization) => {
          const current = organization.id === open.id;
          return (
            <DropdownMenuItem
              key={organization.id}
              onSelect={() => {
                if (!current) void switchTo(organization.id);
              }}
            >
              <OrganizationMark name={organization.name} />
              <span className="min-w-0 flex-1 truncate">{organization.name}</span>
              <Badge tone="neutral" className="capitalize">
                {organization.role}
              </Badge>
              {current ? (
                <Check aria-label="Open now" className="size-4 text-primary" />
              ) : (
                <span className="size-4" />
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => nav.navigate("/onboarding?new=1")}>
          <Plus /> Create {ORGANIZATION_NOUN.one}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
