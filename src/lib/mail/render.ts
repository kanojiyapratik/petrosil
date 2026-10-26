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

/** A brand's own template from `mail_templates`, for a `system:<key>` mail. */
export type StoredTemplate = { subject: string; body: string };

export type RenderContext = {
  /** Where links point, e.g. `https://baseoilreport.com`. No trailing slash. */
  linkBase: string;
  /** Loaded by the caller for a `system:` mail; absent when the brand has none, or it is off. */
  stored?: StoredTemplate | null;
};

export class UnknownTemplate extends Error {
  constructor(template: string) {
    super(`no mail template named "${template}"`);
    this.name = "UnknownTemplate";
  }
}

/**
 * A `system:` mail whose brand has no such template, or has switched it off.
 * Failed rather than sent: a blank or default-worded mail in a brand's name is
 * worse than none.
 */
export class TemplateUnavailable extends Error {
  constructor(key: string) {
    super(`the brand has no enabled "${key}" mail template`);
    this.name = "TemplateUnavailable";
  }
}

/**
 * `{name}`-style placeholders, the old sites' syntax, so the templates carried
 * from them work unchanged. Only the values are escaped for HTML: the template
 * is staff-written HTML and is used as it stands. An unknown placeholder is
 * left visible rather than blanked, so a typo shows up in a test send.
 */
export function fillPlaceholders(
  template: string,
  values: Record<string, unknown>,
  html: boolean,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, name: string) =>
    name in values ? (html ? escape(values[name]) : String(values[name] ?? "")) : whole,
  );
}

/** The plain-text part: paragraphs and line breaks kept, tags and entities gone. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

  /**
   * A newsletter issue sent to one member of staff before it goes to anyone
   * else. The body is the issue's own staff-written HTML, sent exactly as the
   * readers would get it.
   */
  newsletter_test: (mail) => {
    const html = String(mail.payload.html ?? "");

    return { subject: mail.subject, html, text: htmlToText(html) };
  },

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

export const SYSTEM_PREFIX = "system:";

export function renderMail(mail: Queued, context: RenderContext): Rendered {
  if (mail.template.startsWith(SYSTEM_PREFIX)) {
    const stored = context.stored;

    if (!stored) {
      throw new TemplateUnavailable(mail.template.slice(SYSTEM_PREFIX.length));
    }

    const values = (mail.payload.vars ?? {}) as Record<string, unknown>;

    return {
      subject: fillPlaceholders(stored.subject, values, false),
      html: fillPlaceholders(stored.body, values, true),
      // Tags stripped from the template first, then filled: a value that
      // happens to look like a tag is the reader's own text and stays.
      text: fillPlaceholders(htmlToText(stored.body), values, false),
    };
  }

  const template = TEMPLATES[mail.template];

  if (!template) {
    throw new UnknownTemplate(mail.template);
  }

  return template(mail, context);
}
