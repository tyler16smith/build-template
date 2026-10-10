import type { CapturedMail } from "@template/contracts";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  formatRelative,
  PageHeader,
} from "@template/ui";
import { Mail } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAssistantPageContext } from "../assistant/assistant";
import { errorMessage, useApi, useNav } from "../context";

/** Local development only: the mail the app would have sent (`/dev/mail`). */
export function DevMailScreen() {
  const api = useApi();
  const nav = useNav();
  const [mail, setMail] = useState<CapturedMail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useAssistantPageContext({
    title: "Dev mail",
    summary: "Emails the app captured while running locally.",
  });
  const load = useCallback(() => {
    api.dev
      .mail()
      .then(setMail)
      .catch((failure: unknown) => setError(errorMessage(failure)));
  }, [api]);
  useEffect(load, [load]);
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 p-6">
      <PageHeader
        title="Dev mail"
        description="Emails the app sent while running locally. Nothing left your machine."
        actions={
          <Button variant="outline" onClick={load}>
            Refresh
          </Button>
        }
      />
      {error ? <ErrorState error={new Error(error)} onRetry={load} /> : null}
      {mail && !mail.length ? (
        <EmptyState
          icon={Mail}
          title="No mail yet"
          description="Sign up or reset a password to see one here."
        />
      ) : null}
      {mail?.map((message) => (
        <Card key={message.id}>
          <CardHeader
            title={message.subject}
            description={`To ${message.to} · ${formatRelative(new Date(message.sentAt))}`}
          />
          <CardBody className="grid gap-3">
            <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">
              {message.text}
            </pre>
            {message.link ? (
              <Button
                className="justify-self-start"
                onClick={() => {
                  const url = new URL(message.link!);
                  nav.navigate(`${url.pathname}${url.search}`);
                }}
              >
                Open link
              </Button>
            ) : null}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
