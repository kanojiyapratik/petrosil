/**
 * What each system email is for and what sends it, in words for the list
 * and the email's own page.
 *
 * "When" is the truth about this platform, checked against the code on
 * 2026-11-19, not what the old PHP sites did: the four reminders go out from
 * the daily job (domain/billing/reminders.ts), the report and sample emails
 * are the wording staff pick when sending (domain/reports/sending.ts), and
 * the rest were carried over but nothing sends them yet. Saying so is better
 * than a page that implies a welcome email goes out when it does not.
 */

export type EmailWhen = "auto" | "staff" | "none";

export type EmailAbout = { what: string; when: EmailWhen; detail: string };

const ABOUT: Record<string, EmailAbout> = {
  welcome: {
    what: "Greets a new reader with their sign-in details.",
    when: "none",
    detail: "Carried over from the old sites. Nothing on the platform sends it yet.",
  },
  "staff-alert": {
    what: "Tells the brand's own staff that something needs a person.",
    when: "none",
    detail: "Carried over from the old sites. Nothing on the platform sends it yet.",
  },
  "subscription-details": {
    what: "Confirms what a reader has bought and until when.",
    when: "none",
    detail: "Carried over from the old sites. Nothing on the platform sends it yet.",
  },
  "subscription-expiring": {
    what: "Reminds a paying reader that their subscription is about to end.",
    when: "auto",
    detail: "Sent by the renewal reminders, daily at 10:00.",
  },
  "subscription-expired": {
    what: "Tells a reader their subscription has ended.",
    when: "auto",
    detail: "Sent by the renewal reminders, daily at 10:00.",
  },
  "trial-expiring": {
    what: "Reminds a reader that their free trial is about to end.",
    when: "auto",
    detail: "Sent by the trial reminders, daily at 10:00.",
  },
  "trial-expired": {
    what: "Tells a reader their free trial has ended.",
    when: "auto",
    detail: "Sent by the trial reminders, daily at 10:00.",
  },
  "trial-exhausted": {
    what: "Tells a reader their free trial has used up its allowance.",
    when: "none",
    detail: "Carried over from the old sites. Nothing on the platform sends it yet.",
  },
  "send-report": {
    what: "The covering note when staff send a report to paying readers.",
    when: "staff",
    detail: "Used when staff send a report from a brand's Emailer tab.",
  },
  "sample-reports": {
    what: "The covering note when staff send a sample report to a prospect.",
    when: "staff",
    detail: "Used when staff send a sample from a brand's Emailer tab.",
  },
};

const BY_HAND: EmailAbout = {
  what: "An email staff added, to send by hand.",
  when: "staff",
  detail: "Picked as the wording when staff send a report or a sample.",
};

export function emailAbout(key: string): EmailAbout | null {
  return ABOUT[key] ?? (key.startsWith("custom-") ? BY_HAND : null);
}

export const WHEN_LABEL: Record<EmailWhen, { label: string; tone: string }> = {
  auto: { label: "Automatic", tone: "ok" },
  staff: { label: "Sent by staff", tone: "brand" },
  none: { label: "Not sent yet", tone: "" },
};

/** The `{placeholders}` a piece of email text uses, in order of first use. */
export function placeholdersIn(...texts: string[]): string[] {
  const seen = new Set<string>();

  for (const text of texts) {
    for (const match of text.matchAll(/\{([a-z_]+)\}/gi)) {
      seen.add(match[1]!.toLowerCase());
    }
  }

  return [...seen];
}
