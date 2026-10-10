import {
  ActionError,
  AGENT_KINDS,
  AGENT_NAME_PATTERN,
  isUuid,
  type AgentKind,
} from "@template/contracts";
import { getAgentByName } from "agents";
import { checkOrigin, currentSession, inOrganization, type RequestContext } from "../lib/context";
import { AGENT_SESSION_HEADER } from "../modules/assistant/agent";
import { conversationName } from "../modules/assistant/conversations";
import { scopeFor } from "../modules/automations/context";
import { getAutomation } from "../modules/automations/service";

/** `/agents/<kind>/<name>` and anything under it (the socket, `/get-messages`). */
export const AGENT_PATH = /^\/agents\/([a-z]+)\/([A-Za-z0-9_-]{1,64})(\/.*)?$/;

/**
 * The Assistant and the Automation Builder, same origin, over a WebSocket (and HTTP for the
 * history). The Worker checks the session cookie, the membership and, for a socket, `Origin`,
 * then names the Durable Object from the session: `<organization>:<user>:<name>`. The URL alone
 * never decides whose conversation it is. The agent gets the session's hash, so it can check the
 * session again on every turn.
 */
export async function routeAgent(ctx: RequestContext, path: string): Promise<Response> {
  const match = AGENT_PATH.exec(path);
  const kind = match?.[1] as AgentKind | undefined;
  const name = match?.[2] ?? "";
  if (!kind || !AGENT_KINDS.includes(kind) || !AGENT_NAME_PATTERN.test(name))
    throw new ActionError("not_found", "There's nothing here.");
  ctx.route = `agent:${kind}`;
  const request = ctx.request;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (request.headers.get("origin") !== ctx.origin)
      throw new ActionError("forbidden", "This connection didn't come from the app.");
  } else checkOrigin(ctx);
  const signedIn = await currentSession(ctx, []);
  if (!signedIn) throw new ActionError("unauthenticated", "Sign in to continue.");
  const identity = inOrganization(ctx, signedIn);
  if (kind === "automation") {
    if (!isUuid(name)) throw new ActionError("not_found", "That automation doesn't exist.");
    // Throws not_found for an automation in another organization.
    await getAutomation(
      scopeFor(
        ctx,
        { organizationId: identity.organizationId, userId: identity.userId, role: identity.role },
        "agent:automation",
      ),
      name,
    );
  }
  const namespace = (kind === "assistant"
    ? ctx.env.AssistantAgent
    : ctx.env.AutomationAgent) as unknown as Parameters<typeof getAgentByName>[0];
  const agent = await getAgentByName(
    namespace,
    conversationName(identity.organizationId, identity.userId, name),
  );
  const headers = new Headers(request.headers);
  // Only the Worker sets this: a client-sent copy is replaced.
  headers.set(AGENT_SESSION_HEADER, identity.tokenHash);
  return agent.fetch(new Request(request, { headers }));
}
