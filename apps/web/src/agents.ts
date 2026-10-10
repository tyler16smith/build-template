import { createApiClient } from "@template/api-client";
import { AgentClient } from "agents/client";
import { onApiError, organization } from "./organization";

/**
 * The client for the signed-in screens: `api` plus agent connections. Agents (the Assistant and
 * the Automation Builder) are WebSockets to `/agents/<kind>/<name>` on the same origin, through
 * the Agents SDK's client; the Worker checks the session before it reaches them. Only the lazy
 * signed-in chunk imports this, so the sign-in pages don't load the socket client.
 */
export const appApi = createApiClient({
  organization,
  onError: onApiError,
  connectAgent: (kind, name) => {
    const path = `agents/${kind}/${name}`;
    const client = new AgentClient({
      agent: kind === "assistant" ? "AssistantAgent" : "AutomationAgent",
      name,
      host: window.location.host,
      protocol: window.location.protocol === "https:" ? "wss" : "ws",
      basePath: path,
    });
    // What `useAgentChat` reads besides the socket: where the history is, and no error yet.
    return Object.assign(client, {
      getHttpUrl: () => `${window.location.origin}/${path}`,
      connectionError: null,
    });
  },
});
