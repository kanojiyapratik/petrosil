/**
 * What each system email is for and what sends it, in words for the list
 * and the email's own page.
 *
 * "When" is the truth about this platform, checked against the code, not
 * what the old PHP sites did: the four reminders go out from the daily job
 * (domain/billing/reminders.ts); Welcome, Subscription Details and the staff
 * alerts from domain/mail/lifecycle.ts and domain/enquiries/submit.ts; the
 * report and sample emails are the wording staff pick when sending
 * (domain/reports/sending.ts). Trial Usage Exhausted has nothing to send it,
 * and the page says so rather than implying it goes out.
 */

export type EmailWhen = "auto" | "staff" | "none";

export type EmailAbout = { what: string; when: EmailWhen; detail: string };

const ABOUT: Record<string, EmailAbout> = {
  welcome: {
    what: "Welcomes a new reader to the brand.",
    when: "auto",
    detail:
      "Sent when a new reader confirms their email address. Passwords are never emailed: {password} reads 'the password you chose when you registered'.",
  },
  "staff-alert": {
    what: "Tells the brand's staff, at its admin address, that something needs a person.",
    when: "auto",
    detail: "Sent on a new registration, a free trial request, a reader first looking at the plans, and every enquiry (to a company, on an offer, about a plan).",
  },
  "subscription-details": {
    what: "Answers a reader's interest in subscribing with the brand's prices.",
    when: "auto",
    detail: "Sent the first time a signed-in reader without access opens the brand's subscription page. Readers in the subcontinent get the Asia wording.",
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
    detail: "The old sites sent this when a trial used up its download allowance. Trials here have no allowance and end by date, which Trial Expired covers, so nothing sends it.",
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
