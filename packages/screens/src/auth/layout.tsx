import { Alert, Button, Card, CardBody, Separator } from "@template/ui";
import type { ReactNode } from "react";
import { APP_NAME } from "../brand";
import { useApi, useNav, useSession } from "../context";

/** The centered card every signed-out screen uses. */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold text-foreground">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground"
        >
          {APP_NAME.slice(0, 1)}
        </span>
        {APP_NAME}
      </div>
      <Card className="w-full max-w-sm">
        <CardBody className="grid gap-5 p-6">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold text-foreground">{title}</h1>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {children}
        </CardBody>
      </Card>
      {footer ? <div className="mt-4 text-sm text-muted-foreground">{footer}</div> : null}
    </main>
  );
}

/** Continue with Google, only when the server says it's configured. */
export function GoogleButton({ returnTo }: { returnTo: string }) {
  const { session } = useSession();
  const api = useApi();
  const nav = useNav();
  if (!session?.signInMethods.includes("google")) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => nav.openExternal(api.auth.googleUrl(returnTo))}
      >
        <GoogleMark />
        Continue with Google
      </Button>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <Separator className="flex-1" />
        or
        <Separator className="flex-1" />
      </div>
    </>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4">
      <path
        fill="#4285F4"
        d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z"
      />
      <path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.1a11 11 0 0 0 0 9.9l3.7-2.8z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4z"
      />
    </svg>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? <Alert tone="danger">{message}</Alert> : null;
}

/** Keeps `returnTo` on links between the auth screens (the OAuth consent flow relies on it). */
export function withReturnTo(path: string, returnTo: string): string {
  return returnTo && returnTo !== "/" ? `${path}?returnTo=${encodeURIComponent(returnTo)}` : path;
}
