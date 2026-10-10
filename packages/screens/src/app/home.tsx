import { Alert, Button, Card, CardBody, CardHeader, CopyButton, PageHeader } from "@template/ui";
import { useAssistantPageContext } from "../assistant/assistant";
import { Link, useSession } from "../context";
import { VerifyEmailAlert } from "../profile/verify-alert";

/** A placeholder home. The first product module replaces it. */
export function HomeScreen() {
  const { session } = useSession();
  const profile = session?.profile;
  useAssistantPageContext({
    title: "Home",
    summary: "A welcome, and how to connect Claude or ChatGPT over MCP.",
    suggestions: ["What's my job title?", "What can you do for me here?"],
  });
  if (!session || !profile) return null;
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 p-6">
      <PageHeader
        title={`Welcome, ${profile.name.split(" ")[0]}`}
        description={profile.organization ? `You're in ${profile.organization.name}.` : undefined}
      />
      <VerifyEmailAlert />
      <Card>
        <CardHeader
          title="Connect Claude or ChatGPT"
          description="Your AI assistant can read and update your profile through MCP."
        />
        <CardBody className="grid gap-3">
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-sm">
            <span className="flex-1 truncate">{session.mcpUrl}</span>
            <CopyButton text={session.mcpUrl} label="Copy the MCP URL" />
          </div>
          <Button asChild variant="outline" className="justify-self-start">
            <Link to="/profile#connected-apps">See connected apps</Link>
          </Button>
        </CardBody>
      </Card>
      {session.environment !== "production" ? (
        <Alert tone="info" title={`This is ${session.environment}`}>
          Data here is for testing.
        </Alert>
      ) : null}
    </div>
  );
}
