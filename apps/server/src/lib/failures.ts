import type { RequestContext } from "./context";
import { errorResponse, fingerprint, isExpected, toActionError } from "./errors";

/**
 * An unexpected failure, logged once at `error` with its stack and fingerprint (a hash of the
 * error's name, the first frame in our code and `where`). The person sees only
 * `{ code: "internal", message, requestId }`.
 */
export async function reportFailure(
  ctx: RequestContext,
  error: unknown,
  where: string,
): Promise<string> {
  const print = ctx.fingerprint ?? (await fingerprint(error, where));
  ctx.fingerprint = print;
  ctx.log.error("request.failed", {
    route: where,
    fingerprint: print,
    errorCode: "internal",
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return print;
}

/** Any error as the response the person gets: expected ones logged at `info`, the rest reported. */
export async function handleError(ctx: RequestContext, error: unknown): Promise<Response> {
  const actionError = toActionError(error);
  if (isExpected(actionError.code))
    ctx.log.info("request.rejected", { errorCode: actionError.code });
  else await reportFailure(ctx, error, ctx.route);
  return errorResponse(actionError, ctx.requestId);
}
