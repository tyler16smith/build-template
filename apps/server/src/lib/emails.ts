import type { Mail } from "./mail";

/** The emails the app sends. Plain words, one link, and a text part every client can show. */

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function layout(app: string, paragraphs: string[], link?: { href: string; label: string }): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#18181b;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">
<p style="font-weight:600;font-size:18px">${escape(app)}</p>
${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("\n")}
${link ? `<p><a href="${escape(link.href)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${escape(link.label)}</a></p><p style="color:#71717a;font-size:13px">Or paste this link into your browser: ${escape(link.href)}</p>` : ""}
</body></html>`;
}

function text(paragraphs: string[], link?: { href: string; label: string }): string {
  return [...paragraphs, ...(link ? [`${link.label}: ${link.href}`] : [])].join("\n\n");
}

function mail(
  to: string,
  subject: string,
  app: string,
  paragraphs: string[],
  link?: { href: string; label: string },
): Mail {
  return { to, subject, text: text(paragraphs, link), html: layout(app, paragraphs, link) };
}

export function verifyEmail(app: string, to: string, origin: string, token: string): Mail {
  return mail(
    to,
    `Verify your email for ${app}`,
    app,
    ["Confirm this is your email address. The link works for 24 hours."],
    { href: `${origin}/verify-email?token=${encodeURIComponent(token)}`, label: "Verify email" },
  );
}

export function resetPassword(app: string, to: string, origin: string, token: string): Mail {
  return mail(
    to,
    `Reset your ${app} password`,
    app,
    [
      "Someone asked to reset the password for this account. If it was you, choose a new one. The link works for 1 hour.",
      "If it wasn't you, ignore this email: your password stays the same.",
    ],
    {
      href: `${origin}/reset-password?token=${encodeURIComponent(token)}`,
      label: "Choose a new password",
    },
  );
}

export function confirmNewEmail(app: string, to: string, origin: string, token: string): Mail {
  return mail(
    to,
    `Confirm your new email for ${app}`,
    app,
    ["Confirm this address to make it your account's email. The link works for 1 hour."],
    {
      href: `${origin}/verify-email?token=${encodeURIComponent(token)}`,
      label: "Confirm new email",
    },
  );
}

export function emailChangeRequested(app: string, to: string, newEmail: string): Mail {
  return mail(to, `Your ${app} email is changing`, app, [
    `Someone asked to change your account's email to ${newEmail}. It changes once the new address is confirmed.`,
    "If this wasn't you, change your password now and contact us.",
  ]);
}

// ---------------------------------------------------------------- automations (specs/ai.md)

/** An `email.send` or `notify` step's message: the automation's words, paragraph by paragraph. */
export function automationMessage(app: string, to: string, subject: string, body: string): Mail {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return mail(to, subject, app, paragraphs.length ? paragraphs : [subject]);
}

export function approvalRequested(
  app: string,
  to: string,
  automation: string,
  message: string,
  link: string,
): Mail {
  return mail(
    to,
    `Approval needed: ${automation}`,
    app,
    [`“${automation}” is waiting for your decision.`, message],
    { href: link, label: "Approve or decline" },
  );
}

export function automationPaused(
  app: string,
  to: string,
  automation: string,
  reason: string,
  link: string,
): Mail {
  return mail(
    to,
    `“${automation}” was paused`,
    app,
    [reason, "Fix what failed, then resume it from its page."],
    { href: link, label: "Open the automation" },
  );
}

// ---------------------------------------------------------------- organizations (specs/organizations.md)

const INVITED_AS = { admin: "an admin", member: "a member" } as const;

const longDate = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

/**
 * An invitation. Nothing in it but the organization's name, the inviter's name, the role and
 * the link, so it can't be used to send anything else.
 */
export function invitation(
  app: string,
  to: string,
  input: {
    organization: string;
    inviter: string;
    role: "admin" | "member";
    origin: string;
    token: string;
    expiresAt: Date;
  },
): Mail {
  return mail(
    to,
    `${input.inviter} invited you to ${input.organization}`,
    app,
    [
      `You've been invited to join ${input.organization} as ${INVITED_AS[input.role]}.`,
      `This link expires on ${longDate(input.expiresAt)}.`,
    ],
    {
      href: `${input.origin}/invite/${encodeURIComponent(input.token)}`,
      label: "Accept invitation",
    },
  );
}

/** Both people in an ownership transfer hear about it. */
export function ownershipTransferred(
  app: string,
  to: string,
  input: { organization: string; newOwner: string; previousOwner: string; youAreNewOwner: boolean },
): Mail {
  return mail(
    to,
    `${input.organization} has a new owner`,
    app,
    input.youAreNewOwner
      ? [
          `${input.previousOwner} made you the owner of ${input.organization}. They're an admin now.`,
          "As the owner you can rename or delete the company, and make other people owners.",
        ]
      : [
          `You made ${input.newOwner} the owner of ${input.organization}. You're an admin now.`,
          "If this wasn't you, change your password and contact them.",
        ],
  );
}
