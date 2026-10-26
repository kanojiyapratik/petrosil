/**
 * Turning a queued row into the mail a person reads.
 *
 * The outbox stores the template's name and its data, never the finished
 * body, so a wording fix reaches mail that is still waiting. Every value that
 * came from a person is escaped before it goes into HTML: a name is whatever
 * somebody typed into a registration form.
 */

export type Rendered = { subject: string; html: string; text: string };

export type Queued = {
  template: string;
  subject: string;
  payload: Record<string, unknown>;
};

export type RenderContext = {
  /** Where links point, e.g. `https://baseoilreport.com`. No trailing slash. */
  linkBase: string;
};

export class UnknownTemplate extends Error {
  constructor(template: string) {
    super(`no mail template named "${template}"`);
    this.name = "UnknownTemplate";
  }
}

function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function link(context: RenderContext, path: string, token: unknown): string {
  return `${context.linkBase}/${path}?token=${encodeURIComponent(String(token ?? ""))}`;
}

function greeting(payload: Record<string, unknown>): string {
  return payload.name ? `Hello ${String(payload.name)},` : "Hello,";
}

/** One paragraph per entry; a link entry becomes a button in HTML and a bare URL in text. */
type Block = string | { href: string; label: string };

function compose(subject: string, blocks: Block[]): Rendered {
  const html = blocks
    .map((block) =>
      typeof block === "string"
        ? `<p>${escape(block)}</p>`
        : `<p><a href="${escape(block.href)}">${escape(block.label)}</a></p>`,
    )
    .join("\n");

  const text = blocks
    .map((block) => (typeof block === "string" ? block : `${block.label}: ${block.href}`))
    .join("\n\n");

  return { subject, html, text };
}

const TEMPLATES: Record<string, (mail: Queued, context: RenderContext) => Rendered> = {
  verify_email: (mail, context) =>
    compose(mail.subject, [
      greeting(mail.payload),
      "Please confirm this is your email address so we can finish setting up your account.",
      { href: link(context, "verify-email", mail.payload.token), label: "Confirm my email address" },
      "If you did not sign up, you can ignore this message.",
    ]),

  reset_password: (mail, context) =>
    compose(mail.subject, [
      greeting(mail.payload),
      "Someone asked to reset the password on your account. The link works once and expires soon.",
      { href: link(context, "reset-password", mail.payload.token), label: "Set a new password" },
      "If it was not you, ignore this message and your password stays as it is.",
    ]),

  account_exists: (mail, context) =>
    compose(mail.subject, [
      "Hello,",
      `Someone tried to register with this address, but you already have an account${
        mail.payload.siteName ? ` and can now read ${String(mail.payload.siteName)} with it` : ""
      }.`,
      { href: `${context.linkBase}/login`, label: "Sign in" },
      "Forgotten your password? Use the reset link on the sign-in page.",
    ]),
};

export function renderMail(mail: Queued, context: RenderContext): Rendered {
  const template = TEMPLATES[mail.template];

  if (!template) {
    throw new UnknownTemplate(mail.template);
  }

  return template(mail, context);
}
