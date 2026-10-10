import {
  clearCookie,
  exchangeGoogleCode,
  readSignedCookie,
  safeReturnTo,
  signedCookie,
  startGoogleFlow,
  verifyGoogleIdToken,
  type GoogleConfig,
  type GoogleFlow,
} from "@template/auth";
import { ActionError, PATHS } from "@template/contracts";
import type { RequestContext } from "../lib/context";
import { clientIp, rateLimit } from "../lib/context";
import { toActionError } from "../lib/errors";
import { googleEnabled } from "./api";
import { ctxOf, notFound, redirect, router } from "./http";

/**
 * Continue with Google. Without `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` these routes are
 * 404 and no screen shows the button; setting both secrets turns it on, with no code change.
 */
export const googleRoutes = router();

const FLOW_COOKIE = "__Host-google";
const FLOW_SECONDS = 10 * 60;

function config(ctx: RequestContext): GoogleConfig {
  if (!googleEnabled(ctx.env)) notFound();
  return {
    clientId: ctx.env.GOOGLE_CLIENT_ID!,
    clientSecret: ctx.env.GOOGLE_CLIENT_SECRET!,
    redirectUri: `${ctx.origin}${PATHS.googleCallback}`,
  };
}

googleRoutes.get(PATHS.googleStart, async (c) => {
  const ctx = ctxOf(c);
  const google = config(ctx);
  const { flow, url } = await startGoogleFlow(google, safeReturnTo(c.req.query("returnTo")));
  const cookie = await signedCookie(FLOW_COOKIE, flow, ctx.env.SESSION_PEPPER, FLOW_SECONDS);
  return redirect(url, [cookie]);
});

googleRoutes.get(PATHS.googleCallback, async (c) => {
  const ctx = ctxOf(c);
  const google = config(ctx);
  const flow = await readSignedCookie<GoogleFlow>(
    ctx.request.headers.get("cookie"),
    FLOW_COOKIE,
    ctx.env.SESSION_PEPPER,
  );
  const back = (message: string) =>
    redirect(
      `/sign-in?error=${encodeURIComponent(message)}&returnTo=${encodeURIComponent(flow?.returnTo ?? "/")}`,
      [clearCookie(FLOW_COOKIE)],
    );
  try {
    await rateLimit(ctx, ctx.env.AUTH_LIMIT, `google:${clientIp(ctx.request)}`, "google-callback");
    const code = c.req.query("code");
    if (c.req.query("error") || !code) return back("Google sign-in was cancelled.");
    if (!flow || flow.state !== c.req.query("state"))
      throw new ActionError("unauthenticated", "Google sign-in expired. Try again.");
    const idToken = await exchangeGoogleCode(google, code, flow.verifier);
    const claims = await verifyGoogleIdToken(idToken, {
      clientId: google.clientId,
      nonce: flow.nonce,
    });
    const signed = await ctx
      .accounts()
      .signInWithGoogle(claims, ctx.request.headers.get("user-agent"));
    ctx.identify(signed);
    ctx.log.info(signed.created ? "auth.sign_up" : "auth.sign_in", {
      method: "google",
      ...(signed.linked ? { linked: true } : {}),
    });
    return redirect(safeReturnTo(flow.returnTo), [signed.session.cookie, clearCookie(FLOW_COOKIE)]);
  } catch (error) {
    const actionError = toActionError(error);
    ctx.log.info("auth.sign_in_failed", { method: "google", errorCode: actionError.code });
    if (actionError.code === "internal") throw error;
    return back(actionError.message);
  }
});
