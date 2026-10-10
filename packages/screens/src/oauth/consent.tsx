import type { ConsentView } from "@template/contracts";
import { ApiClientError } from "@template/api-client";
import { Alert, Button, Checkbox, ErrorState, Field, LoadingState, Select } from "@template/ui";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthLayout, FormError } from "../auth/layout";
import { organizationLabel } from "../brand";
import { errorMessage, useApi, useNav, useRedirect, useSession, useSubmit } from "../context";

/**
 * `/oauth/consent?handle=…`: an MCP client (Claude, ChatGPT, Cursor) asks to connect. A
 * signed-out person signs in or signs up first and comes back here; the handle survives the
 * detour. Allow is the form's primary submit, so ⌘/Ctrl+Enter works.
 */
export function ConsentScreen({ handle, error }: { handle: string | null; error?: string | null }) {
  const api = useApi();
  const nav = useNav();
  const { session } = useSession();
  const [view, setView] = useState<ConsentView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [organizationId, setOrganizationId] = useState("");
  const [resent, setResent] = useState(false);
  const [needsCompany, setNeedsCompany] = useState(false);
  const signedIn = Boolean(session?.profile);

  useRedirect(
    session && !session.profile && handle
      ? `/sign-in?returnTo=${encodeURIComponent(nav.path)}`
      : // No company yet: name one, then come back (the handle survives the detour).
        needsCompany
        ? `/onboarding?returnTo=${encodeURIComponent(nav.path)}`
        : null,
  );

  useEffect(() => {
    if (!handle || !signedIn) return;
    api.consent
      .get(handle)
      .then((next) => {
        setView(next);
        setChosen(new Set(next.scopes.map((s) => s.id)));
        setOrganizationId(next.organizationId ?? next.organizations[0]?.id ?? "");
      })
      .catch((failure: unknown) => {
        if (failure instanceof ApiClientError && failure.code === "no_organization")
          setNeedsCompany(true);
        else setLoadError(errorMessage(failure));
      });
  }, [api, handle, signedIn]);

  const decide = useSubmit(async (decision: "allow" | "cancel") => {
    const { redirectTo } = await api.consent.decide({
      handle: handle ?? "",
      decision,
      scopes: [...chosen],
      ...(organizationId ? { organizationId } : {}),
    });
    nav.openExternal(redirectTo);
  });

  if (!handle || error)
    return (
      <AuthLayout title="Connect an app">
        <Alert tone="danger">
          {error ?? "This connection request is missing. Start again from your AI app."}
        </Alert>
      </AuthLayout>
    );
  if (loadError)
    return (
      <AuthLayout title="Connect an app">
        <ErrorState title="This request can't continue" error={new Error(loadError)} />
      </AuthLayout>
    );
  if (!view || !session?.profile)
    return (
      <AuthLayout title="Connect an app">
        <LoadingState label="Loading the request" />
      </AuthLayout>
    );

  const profile = session.profile;
  const company =
    view.organizations.find((o) => o.id === organizationId) ?? view.organizations[0] ?? null;
  return (
    <AuthLayout
      title={`Connect ${view.clientName}?`}
      description={
        <>
          {view.clientName} wants to use your account at {company?.name}. You're signed in as{" "}
          {profile.name} ({profile.email}).
        </>
      }
    >
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
        {view.logoUri ? (
          <img
            src={view.logoUri}
            alt=""
            className="size-10 rounded-md"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            aria-hidden
            className="grid size-10 place-items-center rounded-md bg-muted text-muted-foreground"
          >
            <ShieldCheck className="size-5" />
          </span>
        )}
        <div className="min-w-0 text-sm">
          <p className="truncate font-medium text-foreground">{view.clientName}</p>
          <p className="truncate text-muted-foreground">Sends you back to {view.redirectHost}</p>
        </div>
      </div>
      {view.needsVerifiedEmail ? (
        <Alert
          tone="warning"
          title="Verify your email first"
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={resent}
              onClick={() => void api.auth.resendVerification().then(() => setResent(true))}
            >
              {resent ? "Sent" : "Resend link"}
            </Button>
          }
        >
          Open the link we sent to {profile.email}, then come back to this page.
        </Alert>
      ) : null}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void decide.run("allow");
        }}
      >
        <FormError message={decide.error} />
        {view.organizations.length > 1 ? (
          <Field
            label={organizationLabel()}
            hint={`A connection is for one ${organizationLabel().toLowerCase()}. To use another, connect again.`}
          >
            <Select
              value={organizationId}
              onValueChange={setOrganizationId}
              options={view.organizations.map((o) => ({ value: o.id, label: o.name }))}
            />
          </Field>
        ) : null}
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-medium text-foreground">It will be able to</legend>
          {view.scopes.map((scope) => (
            <label key={scope.id} className="flex items-start gap-3 text-sm">
              <Checkbox
                checked={chosen.has(scope.id)}
                disabled={scope.required}
                onCheckedChange={(checked) =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (checked === true) next.add(scope.id);
                    else next.delete(scope.id);
                    return next;
                  })
                }
              />
              <span>
                <span className="text-foreground">{scope.description}</span>
                {scope.required ? (
                  <span className="block text-muted-foreground">Always included</span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            disabled={decide.pending}
            onClick={() => void decide.run("cancel")}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="flex-1"
            loading={decide.pending}
            disabled={view.needsVerifiedEmail}
          >
            Allow
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          You can disconnect it any time from your profile.
        </p>
      </form>
    </AuthLayout>
  );
}
