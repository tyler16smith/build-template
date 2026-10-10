import { uuidv7, type CapturedMail } from "@template/contracts";
import type { Env } from "../env";
import type { Logger } from "./log";

export type Mail = { to: string; subject: string; text: string; html: string };

/** Sends email. Resend in deployed environments; captured locally (see `captureMail`). */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

const CAPTURE_PREFIX = "mail:";
const CAPTURE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Mail that never leaves: everything locally and in tests, and anything to a reserved
 * `.example`/`.test` domain everywhere (the demo accounts and e2e users), so no demo or test
 * address reaches a real inbox. Locally it's shown at `/dev/mail`; on staging the e2e suite reads
 * it through `/api/test/mail` with `TEST_MAIL_SECRET`.
 */
export function capturesMail(env: Env, to: string): boolean {
  return env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test" || /\.(example|test)$/i.test(to);
}

function firstLink(text: string): string | null {
  return /https?:\/\/[^\s<>"']+/.exec(text)?.[0] ?? null;
}

async function captureMail(env: Env, mail: Mail): Promise<void> {
  const id = uuidv7();
  const captured: CapturedMail = {
    id,
    to: mail.to.toLowerCase(),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    sentAt: new Date().toISOString(),
    link: firstLink(mail.text),
  };
  // Keyed by recipient: KV caches a listing for up to a minute, so the e2e suite lists only its
  // fresh address's prefix, which has never been listed before.
  await env.OAUTH_KV.put(`${CAPTURE_PREFIX}${captured.to}:${id}`, JSON.stringify(captured), {
    expirationTtl: CAPTURE_TTL_SECONDS,
  });
}

/** Captured mail, newest first, optionally only to one address. */
export async function capturedMail(env: Env, to?: string): Promise<CapturedMail[]> {
  const prefix = to ? `${CAPTURE_PREFIX}${to.toLowerCase()}:` : CAPTURE_PREFIX;
  const list = await env.OAUTH_KV.list({ prefix, limit: 200 });
  const mails = await Promise.all(
    list.keys.map((k) => env.OAUTH_KV.get<CapturedMail>(k.name, "json")),
  );
  // Ids are UUIDv7, so they sort by time.
  return mails.filter((m): m is CapturedMail => m !== null).sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function createMailer(env: Env, log: Logger): Mailer {
  return {
    async send(mail) {
      if (capturesMail(env, mail.to)) {
        await captureMail(env, mail);
        log.info("mail.captured", { subjectKind: mail.subject.split(" ")[0] });
        return;
      }
      if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
        log.error("mail.not_configured", { errorCode: "internal" });
        throw new Error("RESEND_API_KEY and MAIL_FROM must be set to send email");
      }
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        }),
      });
      if (!response.ok) {
        log.error("mail.send_failed", { status: response.status, errorCode: "internal" });
        throw new Error(`Resend answered ${response.status}`);
      }
      log.info("mail.sent");
    },
  };
}
