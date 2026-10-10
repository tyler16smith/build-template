import { PASSWORD_MIN_LENGTH } from "@template/contracts";
import { Alert, Button, Field, Input, LoadingState, PasswordInput } from "@template/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useApi, useNav, useRedirect, useSession, useSubmit, errorMessage } from "../context";
import { AuthLayout, FormError, GoogleButton, withReturnTo } from "./layout";

/** Only same-origin paths; anything else goes home. */
export function safePath(value: string | null | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/";
}

function useSignedInRedirect(returnTo: string) {
  const { session } = useSession();
  useRedirect(session?.profile ? returnTo : null);
}

export function SignInScreen({
  returnTo = "/",
  error: initialError,
}: {
  returnTo?: string;
  error?: string | null;
}) {
  const api = useApi();
  const nav = useNav();
  const { refresh } = useSession();
  const target = safePath(returnTo);
  useSignedInRedirect(target);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = useSubmit(async () => {
    await api.auth.signIn({ email, password });
    await refresh();
    nav.navigate(target, { replace: true });
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit.run();
  };
  return (
    <AuthLayout
      title="Sign in"
      footer={
        <>
          New here?{" "}
          <Link
            to={withReturnTo("/sign-up", target)}
            className="font-medium text-primary hover:underline"
          >
            Create an account
          </Link>
        </>
      }
    >
      {initialError && !submit.error ? <Alert tone="danger">{initialError}</Alert> : null}
      <GoogleButton returnTo={target} />
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        <FormError message={submit.error} />
        <Field label="Email" error={submit.fields.email}>
          <Input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Password" error={submit.fields.password}>
          <PasswordInput
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" loading={submit.pending} className="w-full">
          Sign in
        </Button>
        <Link
          to="/forgot-password"
          className="text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Forgot your password?
        </Link>
      </form>
    </AuthLayout>
  );
}

export function SignUpScreen({ returnTo = "/" }: { returnTo?: string }) {
  const api = useApi();
  const nav = useNav();
  const { refresh } = useSession();
  const target = safePath(returnTo);
  useSignedInRedirect(target);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Signing up from an invitation: the account is for the address it was sent to.
  const inviteToken = /^\/invite\/([^/?#]+)/.exec(target)?.[1] ?? null;
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  useEffect(() => {
    if (!inviteToken) return;
    api.invitations
      .preview(decodeURIComponent(inviteToken))
      .then((preview) => {
        setInvitedEmail(preview.email);
        setEmail(preview.email);
      })
      .catch(() => setInvitedEmail(null));
  }, [api, inviteToken]);
  const submit = useSubmit(async () => {
    await api.auth.signUp({ name, email, password });
    await refresh();
    nav.navigate(target, { replace: true });
  });
  return (
    <AuthLayout
      title="Create your account"
      description="It takes a minute. We'll send a link to verify your email."
      footer={
        <>
          Have an account?{" "}
          <Link
            to={withReturnTo("/sign-in", target)}
            className="font-medium text-primary hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <GoogleButton returnTo={target} />
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit.run();
        }}
      >
        <FormError message={submit.error} />
        <Field label="Your name" error={submit.fields.name}>
          <Input
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="Email"
          hint={invitedEmail ? "The address your invitation was sent to." : undefined}
          error={submit.fields.email}
        >
          <Input
            type="email"
            autoComplete="email"
            required
            value={email}
            readOnly={invitedEmail !== null}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          label="Password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember and hard to guess.`}
          error={submit.fields.password}
        >
          <PasswordInput
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" loading={submit.pending} className="w-full">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordScreen() {
  const api = useApi();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const submit = useSubmit(async () => {
    await api.auth.forgotPassword(email);
    setSent(true);
  });
  return (
    <AuthLayout
      title="Reset your password"
      description="We'll email you a link to choose a new one."
      footer={
        <Link to="/sign-in" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <Alert tone="success" title="Check your email">
          If an account uses {email}, a reset link is on its way. It works for 1 hour.
        </Alert>
      ) : (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit.run();
          }}
        >
          <FormError message={submit.error} />
          <Field label="Email" error={submit.fields.email}>
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </Field>
          <Button type="submit" loading={submit.pending} className="w-full">
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordScreen({ token }: { token: string | null }) {
  const api = useApi();
  const nav = useNav();
  const [password, setPassword] = useState("");
  const submit = useSubmit(async () => {
    await api.auth.resetPassword({ token: token ?? "", password });
    nav.navigate("/sign-in", { replace: true });
  });
  return (
    <AuthLayout
      title="Choose a new password"
      description="You'll sign in again with it everywhere."
    >
      {!token ? (
        <Alert tone="danger">
          This link is missing its code. Open the link from the email again.
        </Alert>
      ) : (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit.run();
          }}
        >
          <FormError message={submit.error} />
          <Field
            label="New password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            error={submit.fields.password}
          >
            <PasswordInput
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </Field>
          <Button type="submit" loading={submit.pending} className="w-full">
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/** Opens a verify or change-email link: confirms it once, then offers the way on. */
export function VerifyEmailScreen({ token }: { token: string | null }) {
  const api = useApi();
  const { session, refresh } = useSession();
  const [state, setState] = useState<{
    status: "working" | "done" | "failed";
    message?: string;
    email?: string;
  }>({
    status: token ? "working" : "failed",
    message: token ? undefined : "This link is missing its code.",
  });
  const started = useRef(false);
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api.auth
      .verifyEmail(token)
      .then(async (result) => {
        setState({ status: "done", email: result.email });
        await refresh();
      })
      .catch((error: unknown) => setState({ status: "failed", message: errorMessage(error) }));
  }, [api, token, refresh]);
  return (
    <AuthLayout title="Verify your email">
      {state.status === "working" ? <LoadingState label="Checking your link" /> : null}
      {state.status === "done" ? (
        <>
          <Alert tone="success">{state.email} is verified.</Alert>
          <Link
            to={session?.profile ? "/" : "/sign-in"}
            className="text-center text-sm font-medium text-primary hover:underline"
          >
            {session?.profile ? "Continue" : "Sign in"}
          </Link>
        </>
      ) : null}
      {state.status === "failed" ? (
        <>
          <Alert tone="danger">{state.message}</Alert>
          <Link
            to={session?.profile ? "/profile" : "/sign-in"}
            className="text-center text-sm font-medium text-primary hover:underline"
          >
            {session?.profile ? "Go to your profile to send a new link" : "Sign in"}
          </Link>
        </>
      ) : null}
    </AuthLayout>
  );
}
