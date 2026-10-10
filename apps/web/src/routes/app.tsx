import { Outlet } from "@tanstack/react-router";
import { ApiProvider, useSession } from "@template/screens/auth";
import { toast } from "@template/ui";
import { useEffect } from "react";
import {
  AppLayout,
  AutomationEditorScreen,
  AutomationsScreen,
  AutomationStartScreen,
  DevMailScreen,
  HomeScreen,
  InviteScreen,
  MembersScreen,
  OnboardingScreen,
  OrganizationSettingsScreen,
  ProfileScreen,
  ZapierScreen,
} from "@template/screens/app";
import { appApi } from "../agents";
import { takeSwitchNotice } from "../organization";

/** After another tab's switch reloaded this one: says which company is open now. */
function SwitchNotice() {
  const { session } = useSession();
  const name = session?.profile?.organization?.name;
  useEffect(() => {
    if (name && takeSwitchNotice())
      toast(`You switched to ${name} in another tab.`, { tone: "info" });
  }, [name]);
  return null;
}

/** Everything behind sign-in, in one lazy chunk. */
export function AppRoute() {
  return (
    <ApiProvider client={appApi}>
      <AppLayout>
        <SwitchNotice />
        <Outlet />
      </AppLayout>
    </ApiProvider>
  );
}

export const HomeRoute = HomeScreen;
// Outside the app shell (no AppRoute around them), but signed in, so not in the first load.
export const OnboardingRoute = OnboardingScreen;
export const InviteRoute = InviteScreen;
export const ProfileRoute = ProfileScreen;
export const OrganizationSettingsRoute = OrganizationSettingsScreen;
export const MembersRoute = MembersScreen;
export const DevMailRoute = DevMailScreen;
export const AutomationsRoute = AutomationsScreen;
export const AutomationStartRoute = AutomationStartScreen;
export const ZapierRoute = ZapierScreen;

/** `/automations/$automationId`: the id comes from the router; query params are read from nav. */
export function AutomationEditorRoute({ automationId }: { automationId: string }) {
  // A new id is a new editor: its working copy and selection start fresh.
  return <AutomationEditorScreen key={automationId} automationId={automationId} />;
}
