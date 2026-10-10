import type { InvitePreview } from "@template/contracts";
import { Alert, Button, buttonVariants, ErrorState, LoadingState, toast } from "@template/ui";
import { useEffect, useState } from "react";
import { AuthLayout, FormError } from "../auth/layout";
import { ROLE_IN_A_SENTENCE } from "./roles";
import { errorMessage, Link, useApi, useNav, useSession, useSubmit } from "../context";

/**
 * `/invite/:token`: someone was invited to a company. It shows the company, who invited them and
 * the role; a signed-out person signs in or signs up (with the invited email, fixed) and comes
 * back here. Accepting needs the signed-in email to be the invited one.
 */
export function InviteScreen({ token }: { token: string }) {
  const api = useApi();
  const nav = useNav();
  const { session, apply, refresh } = useSession();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api.invitations
      .preview(token)
      .then(setPreview)
      .catch((failure: unknown) => setLoadError(errorMessage(failure)));
  }, [api, token]);

  const accept = useSubmit(async () => {
    apply(await api.invitations.accept(token));
    toast(`Welcome to ${preview?.organization.name ?? "the team"}`, { tone: "success" });
    nav.navigate("/", { replace: true });
  });
  const switchAccount = useSubmit(async () => {
    await api.auth.signOut();
    await refresh();
    nav.navigate(`/sign-in?returnTo=${encodeURIComponent(`/invite/${token}`)}`, {
      replace: true,
    });
  });

  if (loadError)
    return (
      <AuthLayout title="Invitation">
        <ErrorState title="This invitation can't be used" error={new Error(loadError)} />
      </AuthLayout>
    );
  if (!preview || !session)
    return (
      <AuthLayout title="Invitation">
        <LoadingState label="Loading the invitation" />
      </AuthLayout>
    );

  const here = `/invite/${token}`;
  const profile = session.profile;
  const description = (
    <>
      {preview.invitedBy ?? "Someone"} invited you to join{" "}
      <span className="font-medium text-foreground">{preview.organization.name}</span> as{" "}
      {ROLE_IN_A_SENTENCE[preview.role]}.
    </>
  );

  if (!profile)
    return (
      <AuthLayout title={`Join ${preview.organization.name}`} description={description}>
        <p className="text-sm text-muted-foreground">
          Sign in or create an account with {preview.email} to accept.
        </p>
        <div className="grid gap-2">
          <Link
            to={`/sign-up?returnTo=${encodeURIComponent(here)}`}
            className={buttonVariants({ variant: "primary" })}
          >
            Create an account
          </Link>
          <Link
            to={`/sign-in?returnTo=${encodeURIComponent(here)}`}
            className={buttonVariants({ variant: "outline" })}
          >
            Sign in
          </Link>
        </div>
      </AuthLayout>
    );

  if (profile.email.toLowerCase() !== preview.email.toLowerCase())
    return (
      <AuthLayout title={`Join ${preview.organization.name}`} description={description}>
        <Alert tone="warning">
          This invitation is for {preview.email}. You're signed in as {profile.email}.
        </Alert>
        <FormError message={switchAccount.error} />
        <Button loading={switchAccount.pending} onClick={() => void switchAccount.run()}>
          Sign out and continue
        </Button>
      </AuthLayout>
    );

  return (
    <AuthLayout title={`Join ${preview.organization.name}`} description={description}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void accept.run();
        }}
      >
        <FormError message={accept.error} />
        <Button type="submit" loading={accept.pending} className="w-full">
          Accept invitation
        </Button>
      </form>
    </AuthLayout>
  );
}
