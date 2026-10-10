import { ActionError } from "@template/contracts";
import { Hono, type Context } from "hono";
import type { z } from "zod";
import type { Env } from "../env";
import type { RequestContext } from "../lib/context";
import { fromZod } from "../lib/errors";

/** Each request's context, keyed by the request object Hono hands back as `c.req.raw`. */
const contexts = new WeakMap<Request, RequestContext>();

export function attachContext(request: Request, ctx: RequestContext): void {
  contexts.set(request, ctx);
}

export function ctxOf(c: Context): RequestContext {
  const ctx = contexts.get(c.req.raw);
  if (!ctx) throw new Error("No request context");
  return ctx;
}

export function router() {
  return new Hono<{ Bindings: Env }>();
}

const MAX_BODY_BYTES = 16 * 1024;

/** The JSON body, parsed with `schema`. Field errors come back as `invalid_input`. */
export async function body<S extends z.ZodType>(
  c: Context,
  schema: S,
  maxBytes = MAX_BODY_BYTES,
): Promise<z.output<S>> {
  const text = await c.req.text();
  if (text.length > maxBytes) throw new ActionError("invalid_input", "That request is too large.");
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ActionError("invalid_input", "That request isn't valid JSON.");
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw fromZod(parsed.error);
  return parsed.data;
}

/** A JSON response with any cookies the request set (session renewal, sign-in). */
export function json(data: unknown, cookies: string[] = [], status = 200): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return Response.json(data, { status, headers });
}

export function redirect(
  location: string,
  cookies: string[] = [],
  headers = new Headers(),
): Response {
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export function notFound(): never {
  throw new ActionError("not_found", "There's nothing here.");
}
