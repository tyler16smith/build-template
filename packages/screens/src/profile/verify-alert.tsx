import { Alert, Button } from "@template/ui";
import { useState } from "react";
import { errorMessage, useApi, useSession } from "../context";

/** Unverified accounts can use the app; this asks them to verify (and why). */
export function VerifyEmailAlert() {
  const { session } = useSession();
  const api = useApi();
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const profile = session?.profile;
  if (!profile || profile.emailVerified) return null;
  return (
    <Alert
      tone="warning"
      title="Verify your email"
      action={
        <Button
          size="sm"
          variant="outline"
          loading={state === "sending"}
          disabled={state === "sent"}
          onClick={() => {
            setState("sending");
            setError(null);
            api.auth
              .resendVerification()
              .then(() => setState("sent"))
              .catch((failure: unknown) => {
                setError(errorMessage(failure));
                setState("idle");
              });
          }}
        >
          {state === "sent" ? "Sent" : "Resend link"}
        </Button>
      }
    >
      We sent a link to {profile.email}.
      {session.mcpRequiresVerifiedEmail
        ? " You'll need it before connecting Claude or ChatGPT."
        : ""}
      {error ? <span className="mt-1 block text-danger">{error}</span> : null}
    </Alert>
  );
}
