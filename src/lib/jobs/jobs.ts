/**
 * The estate's background jobs, and whether this process should run them.
 *
 * What the old Laravel schedule did and where it went:
 *   subscriptionUpdate:cron (every minute, and the cause of the premium flag
 *     flipping 1↔2)            → `memberships.sweep`, daily
 *   article:cron (publish due articles every minute)
 *                              → not a job: an article whose published_at has
 *                                passed is published when it is read
 *   trial:cron, subscription:cron (reminder mails)
 *                              → not yet; they need the mail templates
 *   demo:cron                  → dropped; it wrote "hello new" into `items`
 */

import { sweepExpiries } from "@/domain/billing/sweep";
import { deliverPending } from "@/lib/mail/deliver";
import { transportFromEnv } from "@/lib/mail/transport";
import type { Job } from "./runner";

export function defaultJobs(env: Record<string, string | undefined> = process.env): Job[] {
  return [
    {
      name: "mail.deliver",
      schedule: { everyMinutes: 1 },
      async run({ database, now }) {
        const transport = transportFromEnv(env);

        // Nothing is claimed without a transport, so nothing spends an
        // attempt: the queue simply waits for the key to be set.
        if (!transport) {
          return { skipped: "no mail transport: set BREVO_API_KEY and MAIL_FROM" };
        }

        return deliverPending(transport, { database, now, env });
      },
    },
    {
      name: "memberships.sweep",
      // The hour the old subscription mails went out.
      schedule: { dailyAt: "11:00" },
      async run({ database }) {
        return sweepExpiries(database);
      },
    },
  ];
}

/**
 * On in production unless `JOBS=off`; elsewhere only with `JOBS=on`. A
 * laptop holding a copy of the real estate must not start mailing it.
 */
export function jobsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env.JOBS ?? "").trim().toLowerCase();

  if (flag === "off") {
    return false;
  }

  return flag === "on" || env.NODE_ENV === "production";
}
