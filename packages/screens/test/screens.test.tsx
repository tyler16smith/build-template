import { createApiClient } from "@template/api-client";
import type { SessionView } from "@template/contracts";
import { ThemeProvider } from "@template/ui";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { permissionsOf, type Role } from "@template/contracts";
import {
  ApiProvider,
  MembersScreen,
  NavProvider,
  OnboardingScreen,
  OrganizationSettingsScreen,
  AppLayout,
  SessionProvider,
  SignInScreen,
  SignUpScreen,
  safePath,
} from "../src";

const signedOut = (methods: SessionView["signInMethods"]): SessionView => ({
  profile: null,
  organizations: [],
  permissions: [],
  account: null,
  signInMethods: methods,
  mcpRequiresVerifiedEmail: true,
  mcpUrl: "https://app.test/mcp",
  environment: "test",
});

const THREE_PIGS = { id: "org-1", name: "Three Pigs Construction", slug: "three-pigs" };

/** Signed in, with Three Pigs open (or no company yet). */
const signedIn = (role: Role | null): SessionView => ({
  ...signedOut(["password"]),
  profile: {
    id: "user-1",
    name: "Bea Brickley",
    title: null,
    email: "bea@threepigs.example",
    emailVerified: true,
    avatarUrl: null,
    organization: role ? THREE_PIGS : null,
    role,
  },
  account: { hasPassword: true, google: { linked: false, email: null } },
  organizations: role
    ? [
        { ...THREE_PIGS, role, lastOpenedAt: null },
        {
          id: "org-2",
          name: "Huff & Puff Testing",
          slug: "huff-and-puff-testing",
          role: "owner",
          lastOpenedAt: null,
        },
      ]
    : [],
  permissions: permissionsOf(role),
});

function render(children: ReactNode, session: SessionView, path = "/sign-in") {
  const nav = { path, navigate() {}, openExternal() {} };
  return renderToString(
    <ThemeProvider>
      <ApiProvider
        client={createApiClient({
          fetch: (() => Promise.reject(new Error("no network"))) as never,
        })}
      >
        <NavProvider nav={nav}>
          <SessionProvider initial={session}>{children}</SessionProvider>
        </NavProvider>
      </ApiProvider>
    </ThemeProvider>,
  );
}

describe("sign-in screens", () => {
  it("show Continue with Google only when it's configured", () => {
    expect(render(<SignInScreen />, signedOut(["password"]))).not.toContain("Continue with Google");
    expect(render(<SignInScreen />, signedOut(["password", "google"]))).toContain(
      "Continue with Google",
    );
    expect(render(<SignUpScreen />, signedOut(["password", "google"]))).toContain(
      "Continue with Google",
    );
  });

  it("keep the return path on links between them", () => {
    const html = render(
      <SignInScreen returnTo="/oauth/consent?handle=h1" />,
      signedOut(["password"]),
    );
    expect(html).toContain('href="/sign-up?returnTo=%2Foauth%2Fconsent%3Fhandle%3Dh1"');
  });

  it("put help text in the hint, never under the input", () => {
    const html = render(<SignUpScreen />, signedOut(["password"]));
    expect(html).toContain("At least 10 characters");
    expect(html).toContain('class="sr-only"');
  });

  it("only follow same-origin return paths", () => {
    expect(safePath("/profile")).toBe("/profile");
    expect(safePath("https://evil.example")).toBe("/");
    expect(safePath("//evil.example")).toBe("/");
  });
});

describe("organization screens", () => {
  it("suggests a company name on onboarding, with one primary button", () => {
    const html = render(<OnboardingScreen />, signedIn(null), "/onboarding");
    expect(html).toContain("Name your company");
    expect(html).toContain('value="Bea Brickley&#x27;s company"');
    expect(html).toContain("Create company");
  });

  it("shows the open company under the person in the sidebar, and the app at the top", () => {
    const html = render(<AppLayout>page</AppLayout>, signedIn("member"), "/");
    expect(html).toContain("Three Pigs Construction");
    expect(html).toContain("Build Template");
  });

  it("offers inviting and company changes only to those who may", () => {
    const members = (role: Role) => render(<MembersScreen />, signedIn(role), "/settings/members");
    expect(members("admin")).toContain("Invite member");
    expect(members("member")).not.toContain("Invite member");
    const settings = (role: Role) =>
      render(<OrganizationSettingsScreen />, signedIn(role), "/settings/organization");
    expect(settings("owner")).toContain("Delete company");
    expect(settings("owner")).toContain("Transfer ownership");
    expect(settings("admin")).not.toContain("Delete company");
    expect(settings("member")).toContain("readOnly");
    expect(settings("member")).toContain("Used in links later.");
  });
});
