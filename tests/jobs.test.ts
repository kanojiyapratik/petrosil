/**
 * The scheduler: what is due, and running each due job exactly once.
 *
 * The old estate's schedule was a Laravel cron that only ran where someone
 * had set up a crontab, plus URLs staff visited by hand. Here the jobs live
 * in the server, and the `scheduled_jobs` row is the lock: however many
 * instances tick at once, and however often they restart, a slot is claimed
 * by one of them. Daily times are India time, because that is when the old
 * reminders went out and when the staff who read the results work.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { mailOutbox, scheduledJobs } from "@/db/schema";
import { queueMail } from "@/lib/mail/outbox";
import { dueCutoff, isDue } from "@/lib/jobs/schedule";
import { runDueJobs, type Job } from "@/lib/jobs/runner";
import { defaultJobs, jobsEnabled } from "@/lib/jobs/jobs";
import { resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

const at = (iso: string) => new Date(iso);

describe("when a job is due", () => {
  it("runs an interval job once the interval has passed", () => {
    const every5 = { everyMinutes: 5 };
    const last = at("2026-10-26T10:00:00Z");

    expect(isDue(every5, null, at("2026-10-26T10:00:00Z"))).toBe(true);
    expect(isDue(every5, last, at("2026-10-26T10:03:00Z"))).toBe(false);
    expect(isDue(every5, last, at("2026-10-26T10:05:00Z"))).toBe(true);
  });

  it("tolerates a tick that lands a moment early", () => {
    // The loop ticks every minute, and timers drift. A one-minute job whose
    // tick arrives 200ms early must not skip a whole minute.
    expect(isDue({ everyMinutes: 1 }, at("2026-10-26T10:00:00Z"), at("2026-10-26T10:00:59.800Z"))).toBe(true);
  });

  it("runs a daily job at its India-time slot and not again that day", () => {
    const daily = { dailyAt: "11:00" }; // 05:30 UTC
    const ranYesterday = at("2026-10-25T05:30:10Z");

    expect(isDue(daily, ranYesterday, at("2026-10-26T05:29:00Z"))).toBe(false);
    expect(isDue(daily, ranYesterday, at("2026-10-26T05:30:00Z"))).toBe(true);

    const ranToday = at("2026-10-26T05:30:05Z");

    expect(isDue(daily, ranToday, at("2026-10-26T23:00:00Z"))).toBe(false);
    expect(isDue(daily, ranToday, at("2026-10-27T05:30:00Z"))).toBe(true);
  });

  it("catches up a daily job the server was down for, once", () => {
    const daily = { dailyAt: "11:00" };

    // Started at 14:00 India time, the slot already passed and never ran.
    expect(isDue(daily, at("2026-10-25T05:30:00Z"), at("2026-10-26T08:30:00Z"))).toBe(true);
    expect(isDue(daily, null, at("2026-10-26T08:30:00Z"))).toBe(true);
  });

  it("reads the slot in India time across the UTC date line", () => {
    // 01:00 India time on the 27th is 19:30 UTC on the 26th.
    expect(dueCutoff({ dailyAt: "01:00" }, at("2026-10-26T20:00:00Z")).toISOString()).toBe(
      "2026-10-26T19:30:00.000Z",
    );
    expect(dueCutoff({ dailyAt: "01:00" }, at("2026-10-26T19:00:00Z")).toISOString()).toBe(
      "2026-10-25T19:30:00.000Z",
    );
  });
});

describe("running the due jobs", () => {
  function counting(name: string, schedule: Job["schedule"]): Job & { runs: number } {
    const job = {
      name,
      schedule,
      runs: 0,
      async run() {
        job.runs++;

        return { done: job.runs };
      },
    };

    return job;
  }

  it("runs a due job and records how it went", async () => {
    const job = counting("demo", { everyMinutes: 5 });
    const now = at("2026-10-26T10:00:00Z");

    const report = await runDueJobs([job], { now });

    expect(report).toEqual([{ name: "demo", status: "ok", result: { done: 1 } }]);

    const [row] = await db().select().from(scheduledJobs).where(eq(scheduledJobs.name, "demo"));

    expect(row!.lastStatus).toBe("ok");
    expect(row!.lastStartedAt!.toISOString()).toBe(now.toISOString());
    expect(row!.lastFinishedAt).not.toBeNull();
    expect(row!.lastResult).toEqual({ done: 1 });
    expect(row!.runs).toBe(1);
  });

  it("does not run it again until it is due", async () => {
    const job = counting("demo", { everyMinutes: 5 });

    await runDueJobs([job], { now: at("2026-10-26T10:00:00Z") });
    const again = await runDueJobs([job], { now: at("2026-10-26T10:02:00Z") });

    expect(again).toEqual([{ name: "demo", status: "not due" }]);
    expect(job.runs).toBe(1);
  });

  it("claims the slot before running, so a second instance does not run it too", async () => {
    const now = at("2026-10-26T10:00:00Z");
    let inner: unknown;

    // While this job is running, another instance ticks at the same moment.
    const job: Job = {
      name: "slow",
      schedule: { everyMinutes: 5 },
      async run() {
        inner = await runDueJobs([job], { now });

        return {};
      },
    };

    await runDueJobs([job], { now });

    expect(inner).toEqual([{ name: "slow", status: "not due" }]);
  });

  it("records a failure and still runs the jobs after it", async () => {
    const broken: Job = {
      name: "broken",
      schedule: { everyMinutes: 1 },
      async run() {
        throw new Error("the provider is down");
      },
    };
    const fine = counting("fine", { everyMinutes: 1 });

    const report = await runDueJobs([broken, fine], { now: at("2026-10-26T10:00:00Z") });

    expect(report).toEqual([
      { name: "broken", status: "failed", error: "the provider is down" },
      { name: "fine", status: "ok", result: { done: 1 } },
    ]);

    const [row] = await db().select().from(scheduledJobs).where(eq(scheduledJobs.name, "broken"));

    expect(row!.lastStatus).toBe("failed");
    expect(row!.lastError).toBe("the provider is down");
  });
});

describe("the estate's jobs", () => {
  it("delivers mail every minute and sweeps expired terms daily at 11:00 India time", () => {
    const schedules = Object.fromEntries(defaultJobs({}).map((job) => [job.name, job.schedule]));

    expect(schedules).toEqual({
      "mail.deliver": { everyMinutes: 1 },
      "memberships.sweep": { dailyAt: "11:00" },
    });
  });

  it("leaves mail queued when no transport is configured, and says why", async () => {
    const id = await queueMail({ to: "x@company.example", subject: "s", template: "verify_email" });
    const mail = defaultJobs({}).find((job) => job.name === "mail.deliver")!;

    const result = await mail.run({ database: db(), now: new Date() });

    expect(result).toEqual({ skipped: "no mail transport: set BREVO_API_KEY and MAIL_FROM" });

    const [row] = await db().select().from(mailOutbox).where(eq(mailOutbox.id, id));

    expect(row!.attempts).toBe(0);
  });

  it("runs in production unless switched off, and on a laptop only when switched on", () => {
    expect(jobsEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(jobsEnabled({ NODE_ENV: "production", JOBS: "off" })).toBe(false);
    expect(jobsEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(jobsEnabled({ NODE_ENV: "development", JOBS: "on" })).toBe(true);
    expect(jobsEnabled({ NODE_ENV: "test" })).toBe(false);
  });
});
