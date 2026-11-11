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
 *                              → `memberships.reminders`, daily, one job
 *   demo:cron                  → dropped; it wrote "hello new" into `items`
 */

import { remindExpiries } from "@/domain/billing/reminders";
import { sweepExpiries } from "@/domain/billing/sweep";
import { deliverPending } from "@/lib/mail/deliver";
import { transportFromEnv } from "@/lib/mail/transport";
import type { Job } from "./runner";
import { indiaDay } from "./schedule";

/**
 * `JOBS=mail` runs mail delivery and nothing else: emailed links (confirm,
 * reset, change of address) work, while the reminder mails and the expiry
 * sweep stay off — for an estate whose membership data is not current yet,
 * where those two would tell every reader their subscription had ended.
 */
const mailOnly = (env: Record<string, string | undefined>) => (env.JOBS ?? "").trim().toLowerCase() === "mail";

export function defaultJobs(env: Record<string, string | undefined> = process.env): Job[] {
  const jobs = allJobs(env);

  return mailOnly(env) ? jobs.filter((job) => job.name === "mail.deliver") : jobs;
}

function allJobs(env: Record<string, string | undefined>): Job[] {
  return [
    {
      name: "mail.deliver",
      schedule: { everyMinutes: 1 },
      async run({ database }) {
        const transport = transportFromEnv(env);

        // Nothing is claimed without a transport, so nothing spends an
        // attempt: the queue simply waits for the key to be set.
        if (!transport) {
          return { skipped: "no mail transport: set BREVO_API_KEY and MAIL_FROM" };
        }

        // No `now`: what is due is judged by the database's clock, which
        // stamped the queue (see deliver.ts).
        return deliverPending(transport, { database, env });
      },
    },
    {
      name: "memberships.reminders",
      // The hour the old trial reminders went out.
      schedule: { dailyAt: "10:00" },
      async run({ database, now }) {
        const day = indiaDay(now);

        return { day, ...(await remindExpiries(database, day)) };
      },
    },
    {
      name: "memberships.sweep",
      // The hour the old subscription mails went out.
      schedule: { dailyAt: "11:00" },
      async run({ database, now }) {
        return sweepExpiries(database, indiaDay(now));
      },
    },
  ];
}

/**
 * On in production unless `JOBS=off`; elsewhere only with `JOBS=on` (or
 * `JOBS=mail`, which runs delivery alone — see defaultJobs). A
 * laptop holding a copy of the real estate must not start mailing it.
 */
export function jobsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env.JOBS ?? "").trim().toLowerCase();

  if (flag === "off") {
    return false;
  }

  return flag === "on" || flag === "mail" || env.NODE_ENV === "production";
}
