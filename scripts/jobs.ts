/**
 * The background jobs, by hand.
 *
 *   npm run jobs                  run whatever is due, once
 *   npm run jobs -- mail.deliver  run that job now, due or not
 *   npm run jobs -- --status      when each job last ran and how it went
 *
 * The server runs these on its own in production (see src/instrumentation.ts).
 * This is for a laptop, for a first run after setting the mail key, and for
 * finding out why something did not go.
 */

import { closeDb, db } from "@/db";
import { scheduledJobs } from "@/db/schema";
import { defaultJobs } from "@/lib/jobs/jobs";
import { runDueJobs, runJob } from "@/lib/jobs/runner";

async function main(): Promise<void> {
  const [argument] = process.argv.slice(2);
  const jobs = defaultJobs();

  if (argument === "--status") {
    const rows = await db().select().from(scheduledJobs).orderBy(scheduledJobs.name);

    if (rows.length === 0) {
      console.log("no job has run yet.");
    }

    for (const row of rows) {
      console.log(
        `${row.name.padEnd(20)} ${String(row.lastStatus ?? "-").padEnd(8)} started ${
          row.lastStartedAt?.toISOString() ?? "never"
        }  runs ${row.runs}  ${row.lastError ?? JSON.stringify(row.lastResult ?? {})}`,
      );
    }

    return;
  }

  if (argument) {
    const job = jobs.find((candidate) => candidate.name === argument);

    if (!job) {
      throw new Error(`no job named "${argument}". Jobs: ${jobs.map((j) => j.name).join(", ")}`);
    }

    console.log(JSON.stringify(await runJob(job, { force: true })));

    return;
  }

  for (const report of await runDueJobs(jobs)) {
    console.log(JSON.stringify(report));
  }
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    await closeDb();
    process.exit(1);
  });
