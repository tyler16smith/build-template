import { personalOrganizationName, type PendingInvite } from "@template/contracts";
import { Button, Field, Input, LoadingState } from "@template/ui";
import { useEffect, useState, type FormEvent } from "react";
import { AuthLayout, FormError } from "../auth/layout";
import { ROLE_IN_A_SENTENCE } from "./roles";
import { safePath } from "../auth/screens";
import { ORGANIZATION_NOUN, organizationLabel } from "../brand";
import { queryParam, useApi, useNav, useRedirect, useSession, useSubmit } from "../context";

/**
 * `/onboarding`: "Name your company". A new account lands here (an invitation link skips it),
 * and so does Create company from the switcher (`?new=1`). Invitations to the person's verified
 * email are offered above the form; joining one skips creating a company.
 */
export function OnboardingScreen() {
  const { session, apply } = useSession();
  const api = useApi();
  const nav = useNav();
  const profile = session?.profile;
  const another = queryParam(nav.path, "new") === "1";
  const returnTo = safePath(queryParam(nav.path, "returnTo"));
  const hasOne = Boolean(profile?.organization);

  useRedirect(
    session && !profile
      ? `/sign-in?returnTo=${encodeURIComponent(nav.path)}`
      : hasOne && !another
        ? returnTo
        : null,
  );

  const [name, setName] = useState(() =>
    profile && !hasOne ? personalOrganizationName(profile.name) : "",
  );
  useEffect(() => {
    if (profile && !hasOne) setName((current) => current || personalOrganizationName(profile.name));
  }, [profile, hasOne]);

  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const verified = Boolean(profile?.emailVerified);
  useEffect(() => {
    if (!verified) return;
    api.invitations
      .pending()
      .then(setInvites)
      .catch(() => setInvites([]));
  }, [api, verified]);

  const create = useSubmit(async () => {
    apply(await api.organizations.create({ name }));
    nav.navigate(returnTo, { replace: true });
  });
  const join = useSubmit(async (inviteId: string) => {
    apply(await api.invitations.join(inviteId));
    nav.navigate(returnTo, { replace: true });
  });

  if (!profile) return <LoadingState label="Loading" className="min-h-dvh" />;
  return (
    <AuthLayout
      title={another ? `Create a ${ORGANIZATION_NOUN.one}` : `Name your ${ORGANIZATION_NOUN.one}`}
      description={
        another
          ? `You'll be its owner. Switch between ${ORGANIZATION_NOUN.many} from the top of the sidebar.`
          : `Everything you add belongs to your ${ORGANIZATION_NOUN.one}, and you can invite your team to it.`
      }
    >
      {invites.length ? (
        <ul className="grid gap-2">
          {invites.map((invite) => (
            <li
              key={invite.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3 text-sm"
            >
              <p className="min-w-0 flex-1">
                {invite.invitedBy ?? "Someone"} invited you to{" "}
                <span className="font-medium text-foreground">{invite.organization.name}</span> as{" "}
                {ROLE_IN_A_SENTENCE[invite.role]}.
              </p>
              <Button
                size="sm"
                variant="outline"
                loading={join.pending}
                onClick={() => void join.run(invite.id)}
              >
                Join
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <FormError message={join.error} />
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void create.run();
        }}
      >
        <FormError message={create.error} />
        <Field label={`${organizationLabel()} name`} error={create.fields.name}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="organization"
            autoFocus
          />
        </Field>
        <Button type="submit" loading={create.pending} className="w-full">
          {`Create ${ORGANIZATION_NOUN.one}`}
        </Button>
        {another ? (
          <Button type="button" variant="ghost" onClick={() => nav.navigate(returnTo)}>
            Cancel
          </Button>
        ) : null}
      </form>
    </AuthLayout>
  );
}
