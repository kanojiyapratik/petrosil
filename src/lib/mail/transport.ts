/**
 * The one place a mail leaves for the outside world.
 *
 * Brevo, because it is what the estate already pays for and what the old
 * sites' transactional helper actually posted to (whatever its name says).
 * The other four providers wired into the old newsletter screen are not
 * carried. Anything else that wants to send — a test, a future SMTP relay —
 * implements `Transport`.
 */

export type OutgoingMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Shown as the sender's name: the brand, so a reader knows who wrote. */
  fromName?: string;
  /**
   * The brand's own address, once a test mail from it has gone through.
   * Without it the transport's address is used: a sender the provider has
   * not verified is refused, and that refusal is permanent.
   */
  fromEmail?: string;
  /** Where a reply goes: the member who wrote, on a forwarded enquiry. */
  replyTo?: string;
  /** Files sent with the mail: a report's PDF, sample reports. */
  attachments?: { name: string; content: Uint8Array }[];
};

export type Transport = {
  name: string;
  send(mail: OutgoingMail): Promise<{ messageId: string | null }>;
};

/**
 * `permanent` decides between "try again later" and "give up now". A
 * rejected address will be rejected every time; a 503 might not be.
 */
export class SendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "SendError";
  }
}

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

export function brevoTransport(options: {
  apiKey: string;
  fromEmail: string;
  fromName?: string;
  fetch?: typeof fetch;
}): Transport {
  const fetcher = options.fetch ?? fetch;

  return {
    name: "brevo",
    async send(mail) {
      let response: Response;

      try {
        response = await fetcher(BREVO_URL, {
          method: "POST",
          headers: {
            "api-key": options.apiKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            sender: { email: mail.fromEmail ?? options.fromEmail, name: mail.fromName ?? options.fromName ?? "Petrosil" },
            to: [{ email: mail.to }],
            subject: mail.subject,
            htmlContent: mail.html,
            textContent: mail.text,
            ...(mail.replyTo ? { replyTo: { email: mail.replyTo } } : {}),
            ...(mail.attachments?.length
              ? {
                  attachment: mail.attachments.map((file) => ({
                    name: file.name,
                    content: Buffer.from(file.content).toString("base64"),
                  })),
                }
              : {}),
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        // The network, a timeout: nothing was decided about this mail.
        throw new SendError(`Brevo unreachable: ${error instanceof Error ? error.message : error}`, false);
      }

      const body = (await response.json().catch(() => ({}))) as { messageId?: string; message?: string };

      if (!response.ok) {
        // 429 and 5xx pass; any other 4xx is about this message and will
        // be refused the same way next time.
        const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;

        throw new SendError(
          `Brevo answered ${response.status}${body.message ? `: ${body.message}` : ""}`,
          permanent,
        );
      }

      return { messageId: body.messageId ?? null };
    },
  };
}

/** Brevo when both its key and a sender address are set; otherwise none. */
export function transportFromEnv(env: Record<string, string | undefined> = process.env): Transport | null {
  const apiKey = (env.BREVO_API_KEY ?? "").trim();
  const fromEmail = (env.MAIL_FROM ?? "").trim();

  if (!apiKey || !fromEmail) {
    return null;
  }

  return brevoTransport({ apiKey, fromEmail, fromName: env.MAIL_FROM_NAME?.trim() || undefined });
}
