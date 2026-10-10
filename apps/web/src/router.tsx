import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  ApiProvider,
  ConsentScreen,
  ForgotPasswordScreen,
  NavProvider,
  ResetPasswordScreen,
  SessionProvider,
  SignInScreen,
  SignUpScreen,
  VerifyEmailScreen,
  type Nav,
} from "@template/screens/auth";
import { ThemeProvider } from "@template/ui";
import { useMemo } from "react";
import { api } from "./api";
import { ErrorBoundary } from "./errors";

/**
 * Routes, and the wiring screens need: the API client and navigation (`useApi`, `useNav`).
 * The signed-out screens load with the app; everything behind sign-in is a lazy chunk.
 */
function Root() {
  const router = useRouter();
  const href = useRouterState({ select: (state) => state.location.href });
  const nav = useMemo<Nav>(
    () => ({
      path: href,
      navigate: (to, options) =>
        options?.replace ? router.history.replace(to) : router.history.push(to),
      openExternal: (url) => window.location.assign(url),
    }),
    [href, router],
  );
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ApiProvider client={api}>
          <NavProvider nav={nav}>
            <SessionProvider>
              <Outlet />
            </SessionProvider>
          </NavProvider>
        </ApiProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

const rootRoute = createRootRoute({ component: Root });

const search = (raw: Record<string, unknown>) => raw as Record<string, string | undefined>;

const signIn = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: search,
  component: function SignIn() {
    const { returnTo, error } = signIn.useSearch();
    return <SignInScreen returnTo={returnTo} error={error} />;
  },
});

const signUp = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-up",
  validateSearch: search,
  component: function SignUp() {
    return <SignUpScreen returnTo={signUp.useSearch().returnTo} />;
  },
});

const forgot = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordScreen,
});

const reset = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: search,
  component: function Reset() {
    return <ResetPasswordScreen token={reset.useSearch().token ?? null} />;
  },
});

const verify = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify-email",
  validateSearch: search,
  component: function Verify() {
    return <VerifyEmailScreen token={verify.useSearch().token ?? null} />;
  },
});

const consent = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/consent",
  validateSearch: search,
  component: function Consent() {
    const { handle, error } = consent.useSearch();
    return <ConsentScreen handle={handle ?? null} error={error} />;
  },
});

/** Name your company (new accounts, and Create company from the switcher). */
const onboarding = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: lazyRouteComponent(() => import("./routes/app"), "OnboardingRoute"),
});

const InviteRoute = lazyRouteComponent(() => import("./routes/app"), "InviteRoute");

/** An invitation link from an email. */
const invite = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: function Invite() {
    return <InviteRoute token={invite.useParams().token} />;
  },
});

/** Signed-in pages: the app shell, loaded lazily. */
const app = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: lazyRouteComponent(() => import("./routes/app"), "AppRoute"),
});

const home = createRoute({
  getParentRoute: () => app,
  path: "/",
  component: lazyRouteComponent(() => import("./routes/app"), "HomeRoute"),
});

const profile = createRoute({
  getParentRoute: () => app,
  path: "/profile",
  component: lazyRouteComponent(() => import("./routes/app"), "ProfileRoute"),
});

const organizationSettings = createRoute({
  getParentRoute: () => app,
  path: "/settings/organization",
  component: lazyRouteComponent(() => import("./routes/app"), "OrganizationSettingsRoute"),
});

const members = createRoute({
  getParentRoute: () => app,
  path: "/settings/members",
  component: lazyRouteComponent(() => import("./routes/app"), "MembersRoute"),
});

const devMail = createRoute({
  getParentRoute: () => app,
  path: "/dev/mail",
  component: lazyRouteComponent(() => import("./routes/app"), "DevMailRoute"),
});

const automations = createRoute({
  getParentRoute: () => app,
  path: "/automations",
  component: lazyRouteComponent(() => import("./routes/app"), "AutomationsRoute"),
});

const automationStart = createRoute({
  getParentRoute: () => app,
  path: "/automations/new",
  component: lazyRouteComponent(() => import("./routes/app"), "AutomationStartRoute"),
});

const AutomationEditorRoute = lazyRouteComponent(
  () => import("./routes/app"),
  "AutomationEditorRoute",
);

/** `?tab=runs&run=<id>` (approval emails link here) and `?prompt=` from the start screen. */
const automationEditor = createRoute({
  getParentRoute: () => app,
  path: "/automations/$automationId",
  validateSearch: search,
  component: function AutomationEditor() {
    const { automationId } = automationEditor.useParams();
    return <AutomationEditorRoute automationId={automationId} />;
  },
});

/** Zapier lives under Automations: it only exists to start them or send from them. */
const zapier = createRoute({
  getParentRoute: () => app,
  path: "/automations/zapier",
  component: lazyRouteComponent(() => import("./routes/app"), "ZapierRoute"),
});

/** The old address, kept so bookmarks and older links still land. */
const legacyZapier = createRoute({
  getParentRoute: () => app,
  path: "/connections/zapier",
  beforeLoad: () => {
    throw redirect({ to: "/automations/zapier", replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  signIn,
  signUp,
  forgot,
  reset,
  verify,
  consent,
  onboarding,
  invite,
  app.addChildren([
    home,
    profile,
    organizationSettings,
    members,
    devMail,
    automations,
    automationStart,
    automationEditor,
    zapier,
    legacyZapier,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
