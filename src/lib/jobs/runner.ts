/**
 * Running whichever jobs are due, each once.
 *
 * The claim is a single UPDATE whose WHERE repeats the due test, so it is the
 * database that decides which instance runs a job: the loser's UPDATE finds
 * the row already moved and touches nothing. A job that dies half-way leaves
 * `last_status = 'running'` and is simply due again at its next slot — every
 * job here is written to be safe to repeat.
 */

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { scheduledJobs } from "@/db/schema";
import { dueCutoff, type Schedule } from "./schedule";

export type JobContext = { database: Database; now: Date };

export type Job = {
  name: string;
  schedule: Schedule;
  run(context: JobContext): Promise<Record<string, unknown>>;
};

export type JobReport =
  | { name: string; status: "ok"; result: Record<string, unknown> }
  | { name: string; status: "failed"; error: string }
  | { name: string; status: "not due" };

async function claim(job: Job, database: Database, now: Date, force: boolean): Promise<boolean> {
  await database.insert(scheduledJobs).values({ name: job.name }).onConflictDoNothing();

  const due = force
    ? undefined
    : or(isNull(scheduledJobs.lastStartedAt), lt(scheduledJobs.lastStartedAt, dueCutoff(job.schedule, now)));

  const claimed = await database
    .update(scheduledJobs)
    .set({ lastStartedAt: now, lastStatus: "running", runs: sql`${scheduledJobs.runs} + 1` })
    .where(and(eq(scheduledJobs.name, job.name), due))
    .returning({ name: scheduledJobs.name });

  return claimed.length > 0;
}

/** Run one job now if it is due — or regardless, with `force`. */
export async function runJob(
  job: Job,
  options: { database?: Database; now?: Date; force?: boolean } = {},
): Promise<JobReport> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();

  if (!(await claim(job, database, now, options.force ?? false))) {
    return { name: job.name, status: "not due" };
  }

  try {
    const result = await job.run({ database, now });

    await database
      .update(scheduledJobs)
      .set({ lastStatus: "ok", lastFinishedAt: new Date(), lastResult: result, lastError: null })
      .where(eq(scheduledJobs.name, job.name));

    return { name: job.name, status: "ok", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await database
      .update(scheduledJobs)
      .set({ lastStatus: "failed", lastFinishedAt: new Date(), lastError: message.slice(0, 2000) })
      .where(eq(scheduledJobs.name, job.name));

    return { name: job.name, status: "failed", error: message };
  }
}

/** One tick: every job in turn. A failure is recorded and the next job still runs. */
export async function runDueJobs(
  jobs: Job[],
  options: { database?: Database; now?: Date } = {},
): Promise<JobReport[]> {
  const reports: JobReport[] = [];

  for (const job of jobs) {
    reports.push(await runJob(job, options));
  }

  return reports;
}
