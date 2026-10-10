import { PASSWORD_MIN_LENGTH, type OrganizationRef } from "@template/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  PasswordInput,
  toast,
} from "@template/ui";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { FormError } from "../auth/layout";
import { ORGANIZATION_NOUN } from "../brand";
import { Link, useApi, useNav, useSession, useSubmit } from "../context";
import { ROLE_LABELS } from "../organization/roles";
import { SettingsLayout } from "../settings/layout";
import { useAssistantPageContext } from "../assistant/assistant";
import { AiSettingsCard } from "../assistant/settings";
import { ConnectedApps } from "./connected-apps";
import { VerifyEmailAlert } from "./verify-alert";

/**
 * The CRUD example every feature copies: read from the session (no extra fetch), update through
 * an action, and the account's credentials through the auth routes.
 */
export function ProfileScreen() {
  const { session } = useSession();
  useAssistantPageContext({
    title: "Profile",
    summary: "Your name, job title, email, sign-in methods and connected apps.",
    suggestions: ["What's my job title?", "Change my job title", "Which apps are connected?"],
  });
  if (!session?.profile || !session.account) return null;
  return (
    <SettingsLayout description="Your details, how you sign in, and the apps you've connected.">
      <VerifyEmailAlert />
      <DetailsCard />
      <EmailCard />
      <SignInCard />
      <ConnectedApps />
      <AiSettingsCard />
      <DangerCard />
    </SettingsLayout>
  );
}

function DetailsCard() {
  const { session, refresh } = useSession();
  const api = useApi();
  const profile = session!.profile!;
  const [name, setName] = useState(profile.name);
  const [title, setTitle] = useState(profile.title ?? "");
  useEffect(() => {
    setName(profile.name);
    setTitle(profile.title ?? "");
  }, [profile.name, profile.title]);
  const changed = name.trim() !== profile.name || title.trim() !== (profile.title ?? "");
  const save = useSubmit(async () => {
    await api.profile.update({ name, title });
    await refresh();
    toast("Profile saved", { tone: "success" });
  });
  return (
    <Card>
      <CardHeader
        title="Your details"
        description={
          profile.organization && profile.role
            ? `${profile.organization.name} · ${ROLE_LABELS[profile.role]}`
            : undefined
        }
      />
      <CardBody>
        <form
          className="grid gap-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void save.run();
          }}
        >
          <FormError message={save.error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={save.fields.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </Field>
            <Field
              label="Job title (optional)"
              hint="Shown to your team, such as Technician or Dispatcher."
              error={save.fields.title}
            >
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoComplete="organization-title"
              />
            </Field>
          </div>
          <Button
            type="submit"
            loading={save.pending}
            disabled={!changed}
            className="justify-self-start"
          >
            Save
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function EmailCard() {
  const { session } = useSession();
  const profile = session!.profile!;
  const account = session!.account!;
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Email"
        actions={
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Change email
          </Button>
        }
      />
      <CardBody className="flex items-center gap-2 text-sm">
        <span className="text-foreground">{profile.email}</span>
        {profile.emailVerified ? (
          <Badge tone="success">Verified</Badge>
        ) : (
          <Badge tone="warning">Not verified</Badge>
        )}
      </CardBody>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Change your email"
          description="We'll send a link to the new address. It changes once you open it."
        >
          {account.hasPassword ? (
            <ChangeEmailForm onDone={() => setOpen(false)} />
          ) : (
            <Alert tone="warning">
              Set a password first (under Sign-in), so we can confirm it's you.
            </Alert>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ChangeEmailForm({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const submit = useSubmit(async () => {
    await api.auth.changeEmail({ email, currentPassword });
    toast("Check your new inbox", {
      description: `We sent a confirmation link to ${email}.`,
      tone: "success",
    });
    onDone();
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit.run();
      }}
    >
      <FormError message={submit.error} />
      <Field label="New email" error={submit.fields.email}>
        <Input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
      </Field>
      <Field label="Current password" error={submit.fields.currentPassword}>
        <PasswordInput
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </Field>
      <DialogFooter>
        <Button type="submit" loading={submit.pending}>
          Send link
        </Button>
      </DialogFooter>
    </form>
  );
}

function Row({ title, detail, action }: { title: string; detail: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function SignInCard() {
  const { session, refresh } = useSession();
  const api = useApi();
  const nav = useNav();
  const account = session!.account!;
  const [passwordOpen, setPasswordOpen] = useState(false);
  const unlink = useSubmit(async () => {
    await api.auth.unlinkGoogle();
    await refresh();
    toast("Google unlinked", { tone: "success" });
  });
  const everywhere = useSubmit(async () => {
    await api.auth.signOutEverywhere();
    await refresh();
    nav.navigate("/sign-in", { replace: true });
  });
  return (
    <Card>
      <CardHeader title="Sign-in" description="How you get into your account." />
      <CardBody className="divide-y divide-border">
        <Row
          title="Password"
          detail={account.hasPassword ? "Set." : "Not set. You sign in with Google."}
          action={
            <Button variant="outline" size="sm" onClick={() => setPasswordOpen(true)}>
              {account.hasPassword ? "Change password" : "Set a password"}
            </Button>
          }
        />
        <Row
          title="Google"
          detail={
            account.google.linked
              ? `Signed in with Google (${account.google.email}).`
              : "Not linked."
          }
          action={
            account.google.linked && account.hasPassword ? (
              <Button
                variant="outline"
                size="sm"
                loading={unlink.pending}
                onClick={() => void unlink.run()}
              >
                Unlink
              </Button>
            ) : null
          }
        />
        <Row
          title="Everywhere you're signed in"
          detail="Sign out on every browser and device, including this one."
          action={
            <Button
              variant="outline"
              size="sm"
              loading={everywhere.pending}
              onClick={() => void everywhere.run()}
            >
              Sign out everywhere
            </Button>
          }
        />
        {unlink.error || everywhere.error ? (
          <div className="pt-3">
            <FormError message={unlink.error ?? everywhere.error} />
          </div>
        ) : null}
      </CardBody>
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent
          title={account.hasPassword ? "Change your password" : "Set a password"}
          description={
            account.hasPassword
              ? "Other browsers and devices will be signed out."
              : "Then you can sign in with your email too."
          }
        >
          <PasswordForm hasPassword={account.hasPassword} onDone={() => setPasswordOpen(false)} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PasswordForm({ hasPassword, onDone }: { hasPassword: boolean; onDone: () => void }) {
  const api = useApi();
  const { refresh } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const submit = useSubmit(async () => {
    if (hasPassword) await api.auth.changePassword({ currentPassword, newPassword });
    else await api.auth.setPassword({ newPassword });
    await refresh();
    toast(hasPassword ? "Password changed" : "Password set", { tone: "success" });
    onDone();
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit.run();
      }}
    >
      <FormError message={submit.error} />
      {hasPassword ? (
        <Field label="Current password" error={submit.fields.currentPassword}>
          <PasswordInput
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoFocus
          />
        </Field>
      ) : null}
      <Field
        label="New password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        error={submit.fields.newPassword}
      >
        <PasswordInput
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoFocus={!hasPassword}
        />
      </Field>
      <DialogFooter>
        <Button type="submit" loading={submit.pending}>
          Save password
        </Button>
      </DialogFooter>
    </form>
  );
}

function DangerCard() {
  const { session, refresh } = useSession();
  const api = useApi();
  const nav = useNav();
  const account = session!.account!;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  // Companies they're the only owner of (with other members) block deleting the account.
  const [blockers, setBlockers] = useState<OrganizationRef[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setBlockers(null);
    api.auth
      .deletionBlockers()
      .then(setBlockers)
      .catch(() => setBlockers([]));
  }, [api, open]);
  const blocked = Boolean(blockers?.length);
  const remove = useSubmit(async () => {
    await api.auth.deleteAccount({
      confirm: confirm as "DELETE",
      ...(account.hasPassword ? { currentPassword } : {}),
    });
    await refresh();
    nav.navigate("/sign-in", { replace: true });
  });
  return (
    <Card className="border-danger/40">
      <CardHeader
        title="Delete account"
        description="Signs you out everywhere and disconnects your apps now. We remove your account for good after 30 days."
        actions={
          <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
            Delete account
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Delete your account?"
          description="You can't undo this after 30 days."
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void remove.run();
            }}
          >
            {blocked ? (
              <Alert tone="warning" title="Make someone else an owner first">
                You're the only owner of{" "}
                {blockers!.map((organization, i) => (
                  <span key={organization.id}>
                    {i ? ", " : ""}
                    <Link
                      to={`/settings/members?org=${organization.id}`}
                      className="font-medium underline"
                      onClick={() => setOpen(false)}
                    >
                      {organization.name}
                    </Link>
                  </span>
                ))}
                . Each {ORGANIZATION_NOUN.one} needs an owner after you've gone.
              </Alert>
            ) : null}
            <FormError message={remove.error} />
            <Field label="Type DELETE to confirm" error={remove.fields.confirm}>
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                autoFocus
              />
            </Field>
            {account.hasPassword ? (
              <Field label="Current password" error={remove.fields.currentPassword}>
                <PasswordInput
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </Field>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                submitShortcut
                loading={remove.pending}
                disabled={confirm !== "DELETE" || blocked || blockers === null}
              >
                Delete account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
