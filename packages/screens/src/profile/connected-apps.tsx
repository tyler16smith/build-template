import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CopyButton,
  ErrorState,
  formatRelative,
  Skeleton,
} from "@template/ui";
import { Plug } from "lucide-react";
import { FormError } from "../auth/layout";
import { errorMessage, useApi, useSession, useSubmit } from "../context";
import { useLoad } from "../use-load";

/**
 * The person's live MCP grants, each with the company it's connected to, with Disconnect; an
 * empty state explains how to connect. Connecting a second company is a second connection.
 */
export function ConnectedApps() {
  const api = useApi();
  const { session } = useSession();
  const list = useLoad(() => api.connections.list(), "connections");
  const connections = list.data;
  const error = list.error ? errorMessage(list.error) : null;
  const revoke = useSubmit(async (id: string) => {
    await api.connections.revoke(id);
    list.update((rows) => rows?.filter((c) => c.id !== id) ?? null);
  });

  return (
    <Card id="connected-apps">
      <CardHeader
        title="Connected apps"
        description="AI apps that can use your account through MCP."
      />
      <CardBody className="grid gap-4">
        <FormError message={revoke.error} />
        {error ? (
          <ErrorState
            title="Couldn't load connected apps"
            error={new Error(error)}
            onRetry={() => void list.refetch()}
          />
        ) : null}
        {!connections && !error ? <Skeleton className="h-12" /> : null}
        {connections?.length ? (
          <ul className="divide-y divide-border">
            {connections.map((connection) => (
              <li key={connection.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
                <span
                  aria-hidden
                  className="grid size-9 place-items-center rounded-md bg-muted text-muted-foreground"
                >
                  <Plug className="size-4" />
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium text-foreground">
                    {connection.clientName}
                    {connection.organization ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {connection.organization.name}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground">
                    Connected {formatRelative(new Date(connection.connectedAt))}
                    {connection.lastUsedAt
                      ? ` · last used ${formatRelative(new Date(connection.lastUsedAt))}`
                      : ""}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {connection.scopes.map((scope) => (
                      <Badge key={scope} tone="neutral">
                        {scope}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  loading={revoke.pending}
                  onClick={() => void revoke.run(connection.id)}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {connections && !connections.length && session ? (
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">
              Nothing is connected yet. To connect, add this MCP server URL to your AI app:
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono">
              <span className="flex-1 truncate">{session.mcpUrl}</span>
              <CopyButton text={session.mcpUrl} label="Copy the MCP URL" />
            </div>
            <ul className="grid gap-1 text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">Claude:</span> Settings → Connectors →
                Add custom connector, paste the URL, then Connect.
              </li>
              <li>
                <span className="font-medium text-foreground">ChatGPT:</span> Settings → Apps &amp;
                Connectors → Create, paste the URL, choose OAuth, then Connect.
              </li>
            </ul>
            <p className="text-muted-foreground">You'll be sent here to approve it.</p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
