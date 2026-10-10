import { OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ALL_SCOPES, mayRun, toolName, type Role } from "@template/contracts";
import { z } from "zod";
import type { ServerAction } from "../actions/define";
import { REGISTRY, runAction } from "../actions/registry";
import type { Env } from "../env";
import type { RequestContext } from "../lib/context";
import { errorBody, isExpected, toActionError } from "../lib/errors";
import { handleError, reportFailure } from "../lib/failures";
import {
  authorizationServer,
  grantIdOf,
  grantIsLive,
  grantProps,
  mcpRequiresVerifiedEmail,
  mcpResource,
  touchGrant,
  verifyMembership,
  type GrantProps,
} from "./oauth";

type McpCaller = GrantProps & Awaited<ReturnType<typeof verifyMembership>>;

/**
 * Actions an MCP client can see: not web-only, within its scopes (write tools only with write),
 * and permitted to the person's role (a member's connection never lists `members_remove`).
 */
export function visibleActions(scopes: readonly string[], role: Role): ServerAction[] {
  return Object.values(REGISTRY).filter(
    (a) => !a.webOnly && scopes.includes(a.scope) && mayRun(a, role),
  );
}

export function toolDefinition(action: ServerAction) {
  return {
    name: toolName(action.id),
    title: action.title,
    description: action.description,
    inputSchema: z.toJSONSchema(action.input, { io: "input", unrepresentable: "any" }) as {
      type: "object";
      properties?: Record<string, object>;
    },
    outputSchema: z.toJSONSchema(action.output, { io: "output", unrepresentable: "any" }) as {
      type: "object";
      properties?: Record<string, object>;
    },
    annotations: {
      title: action.title,
      readOnlyHint: action.readOnly,
      destructiveHint: action.confirm ?? false,
      idempotentHint: action.readOnly,
      openWorldHint: false,
    },
  };
}

function createServer(ctx: RequestContext, caller: McpCaller): Server {
  const server = new Server(
    { name: ctx.env.APP_NAME, version: ctx.version },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleActions(caller.scopes, caller.role).map(toolDefinition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const action = Object.values(REGISTRY).find((a) => toolName(a.id) === request.params.name);
    if (!action || action.webOnly)
      return {
        content: [
          { type: "text" as const, text: `There's no tool called ${request.params.name}.` },
        ],
        isError: true,
      };
    ctx.route = `mcp:${action.id}`;
    try {
      const output = await runAction(ctx, action, request.params.arguments ?? {}, {
        ...caller,
        caller: "mcp",
      });
      const structured =
        output && typeof output === "object" && !Array.isArray(output)
          ? (output as Record<string, unknown>)
          : { result: output };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: structured,
      };
    } catch (error) {
      const actionError = toActionError(error);
      if (!isExpected(actionError.code)) await reportFailure(ctx, error, action.id);
      const body = errorBody(actionError, ctx.requestId).error;
      return {
        content: [
          {
            type: "text" as const,
            text: `${body.message} (${body.code}; request ${body.requestId})`,
          },
        ],
        structuredContent: { error: body },
        isError: true,
      };
    }
  });
  return server;
}

type ResourceContext = ExecutionContext & {
  props: unknown;
  auth: { scope?: string[]; clientId?: string; token?: string };
};

async function serveMcp(ctx: RequestContext, request: Request, resourceCtx: ResourceContext) {
  try {
    return await connectMcp(ctx, request, resourceCtx);
  } catch (error) {
    return handleError(ctx, error);
  }
}

async function connectMcp(ctx: RequestContext, request: Request, resourceCtx: ResourceContext) {
  const props = grantProps(resourceCtx.props, resourceCtx.auth.scope);
  ctx.identify(props);
  ctx.mcpClient = props.clientName;
  const membership = await verifyMembership(ctx, props);
  if (mcpRequiresVerifiedEmail(ctx.env) && !membership.emailVerified)
    return Response.json(
      {
        error: "email_unverified",
        error_description: "Verify your email address in the app before connecting.",
      },
      { status: 403 },
    );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await createServer(ctx, { ...props, ...membership }).connect(transport);
  return transport.handleRequest(request);
}

/**
 * `/mcp` and its resource metadata. The resource server challenges a request without a token
 * (401 with `WWW-Authenticate` pointing at the metadata), validates the token's audience and
 * expiry, and only then calls `serveMcp`. A token whose grant was revoked is refused at once
 * (`grantIsLive`).
 */
export function mcpResourceServer(ctx: RequestContext): OAuthResourceServer<Env, unknown> {
  const server = authorizationServer(ctx.origin);
  return new OAuthResourceServer<Env, unknown>({
    resourceMetadata: {
      resource: mcpResource(ctx.origin),
      authorization_servers: [ctx.origin],
      scopes_supported: [...ALL_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: ctx.env.APP_NAME,
    },
    handler: {
      fetch: (request, _env, resourceCtx) =>
        serveMcp(ctx, request, resourceCtx as unknown as ResourceContext),
    },
    validateToken: (env) => async (resource, token) => {
      const valid = await server.validateToken(resource, token, env);
      if (!valid || !(await grantIsLive(env.OAUTH_KV, token))) return null;
      const grantId = grantIdOf(token);
      if (grantId) touchGrant(ctx, grantId);
      return valid;
    },
  });
}
