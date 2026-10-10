import { sessionCookie, sha256Base64Url } from "@template/auth";
import {
  ChangeEmailInput,
  ChangePasswordInput,
  DeleteAccountInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  SetPasswordInput,
  SignInInput,
  SignUpInput,
  VerifyEmailInput,
  type EmailTokenResult,
} from "@template/contracts";
import { z } from "zod";
import { checkOrigin, clientIp, rateLimit, requireSession, sessionToken } from "../lib/context";
import * as emails from "../lib/emails";
import { revokeAllGrants } from "../mcp/oauth";
import { body, ctxOf, json, router } from "./http";

/**
 * Sign-up, sign-in and the account's credentials. Plain routes, not actions: they set cookies and
 * aren't offered to MCP clients. Auth events log the user id when it's known, never the email.
 */
export const authRoutes = router();

const userAgent = (request: Request) => request.headers.get("user-agent");
/** Rate-limit keys for an email: hashed, so the limiter never holds the address. */
const emailKey = async (email: string) => sha256Base64Url(email.toLowerCase());

authRoutes.post("/sign-up", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  await rateLimit(ctx, ctx.env.AUTH_LIMIT, `sign-up:${clientIp(ctx.request)}`, "sign-up");
  const input = await body(c, SignUpInput);
  const signed = await ctx.accounts().signUp(input, userAgent(ctx.request));
  ctx.identify(signed);
  ctx.log.info("auth.sign_up", { method: "password" });
  await ctx.mailer.send(
    emails.verifyEmail(ctx.env.APP_NAME, input.email, ctx.origin, signed.verifyToken),
  );
  return json({ ok: true }, [signed.session.cookie]);
});

authRoutes.post("/sign-in", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const input = await body(c, SignInInput);
  await rateLimit(ctx, ctx.env.AUTH_LIMIT, `sign-in:${clientIp(ctx.request)}`, "sign-in");
  await rateLimit(
    ctx,
    ctx.env.AUTH_LIMIT,
    `sign-in:${await emailKey(input.email)}`,
    "sign-in-email",
  );
  try {
    const signed = await ctx.accounts().signIn(input, userAgent(ctx.request));
    ctx.identify(signed);
    ctx.log.info("auth.sign_in", { method: "password" });
    return json({ ok: true }, [signed.session.cookie]);
  } catch (error) {
    ctx.log.info("auth.sign_in_failed", { method: "password" });
    throw error;
  }
});

authRoutes.post("/sign-out", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const token = sessionToken(ctx.request);
  if (token) await ctx.accounts().sessions.end(token);
  ctx.log.info("auth.sign_out");
  return json({ ok: true }, [sessionCookie(null)]);
});

authRoutes.post("/sign-out-everywhere", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const identity = await requireSession(ctx, []);
  await ctx.database().one((d) => ctx.accounts().sessions.endAllStatement(d, identity.userId));
  ctx.log.info("auth.sign_out_everywhere");
  return json({ ok: true }, [sessionCookie(null)]);
});

authRoutes.post("/forgot-password", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const input = await body(c, ForgotPasswordInput);
  await rateLimit(ctx, ctx.env.AUTH_LIMIT, `reset:${clientIp(ctx.request)}`, "password-reset");
  await rateLimit(
    ctx,
    ctx.env.AUTH_LIMIT,
    `reset:${await emailKey(input.email)}`,
    "password-reset-email",
  );
  const reset = await ctx.accounts().requestPasswordReset(input.email);
  if (reset) {
    ctx.log.info("auth.password_reset_requested", { userId: reset.userId });
    await ctx.mailer.send(
      emails.resetPassword(ctx.env.APP_NAME, reset.email, ctx.origin, reset.token),
    );
  } else ctx.log.info("auth.password_reset_requested", { known: false });
  // The same answer either way, so the form doesn't reveal which emails have accounts.
  return json({ ok: true });
});

authRoutes.post("/reset-password", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  await rateLimit(
    ctx,
    ctx.env.AUTH_LIMIT,
    `reset-confirm:${clientIp(ctx.request)}`,
    "password-reset",
  );
  const input = await body(c, ResetPasswordInput);
  const { userId } = await ctx.accounts().resetPassword(input.token, input.password);
  ctx.log.info("auth.password_reset", { userId });
  await revokeAllGrants(ctx, userId);
  return json({ ok: true }, [sessionCookie(null)]);
});

authRoutes.post("/verify-email", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const input = await body(c, VerifyEmailInput);
  const result = await ctx.accounts().confirmEmail(input.token);
  ctx.log.info(result.purpose === "verify" ? "auth.email_verified" : "auth.email_changed", {
    userId: result.userId,
  });
  const response: EmailTokenResult = { ok: true, purpose: result.purpose, email: result.email };
  return json(response);
});

authRoutes.post("/resend-verification", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const identity = await requireSession(ctx, []);
  await rateLimit(ctx, ctx.env.AUTH_LIMIT, `verify:${identity.userId}`, "resend-verification");
  const verify = await ctx.accounts().resendVerification(identity.userId);
  if (verify)
    await ctx.mailer.send(
      emails.verifyEmail(ctx.env.APP_NAME, verify.email, ctx.origin, verify.token),
    );
  return json({ ok: true, alreadyVerified: !verify });
});

authRoutes.post("/change-email", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const identity = await requireSession(ctx, []);
  const input = await body(c, ChangeEmailInput);
  await rateLimit(ctx, ctx.env.AUTH_LIMIT, `change-email:${identity.userId}`, "change-email");
  const change = await ctx
    .accounts()
    .requestEmailChange(identity.userId, input.email, input.currentPassword);
  ctx.log.info("auth.email_change_requested");
  await ctx.mailer.send(
    emails.confirmNewEmail(ctx.env.APP_NAME, change.newEmail, ctx.origin, change.token),
  );
  await ctx.mailer.send(
    emails.emailChangeRequested(ctx.env.APP_NAME, change.oldEmail, change.newEmail),
  );
  return json({ ok: true });
});

authRoutes.post("/change-password", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const identity = await requireSession(ctx, []);
  await rateLimit(ctx, ctx.env.AUTH_LIMIT, `change-password:${identity.userId}`, "change-password");
  const input = await body(c, ChangePasswordInput);
  await ctx
    .accounts()
    .changePassword(identity.userId, input.currentPassword, input.newPassword, identity.tokenHash);
  ctx.log.info("auth.password_changed");
  return json({ ok: true });
});

authRoutes.post("/set-password", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const identity = await requireSession(ctx, []);
  const input = await body(c, SetPasswordInput);
  await ctx.accounts().setPassword(identity.userId, input.newPassword);
  ctx.log.info("auth.password_set");
  return json({ ok: true });
});

authRoutes.post("/unlink-google", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const identity = await requireSession(ctx, []);
  await body(c, z.object({}));
  await ctx.accounts().unlinkGoogle(identity.userId);
  ctx.log.info("auth.google_unlinked");
  return json({ ok: true });
});

authRoutes.post("/delete-account", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const identity = await requireSession(ctx, []);
  const input = await body(c, DeleteAccountInput);
  await ctx.accounts().deleteAccount(identity.userId, input.currentPassword);
  ctx.log.info("auth.account_deleted");
  await revokeAllGrants(ctx, identity.userId);
  return json({ ok: true }, [sessionCookie(null)]);
});
