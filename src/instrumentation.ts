/**
 * Runs once when a server starts. Here it starts the background jobs —
 * mail delivery and the expiry sweep — on the Node runtime only, and only
 * where `jobsEnabled` says so (production, or `JOBS=on`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { defaultJobs, jobsEnabled } = await import("@/lib/jobs/jobs");

  if (!jobsEnabled()) {
    return;
  }

  const { startLoop } = await import("@/lib/jobs/loop");
  const { runDueJobs } = await import("@/lib/jobs/runner");
  const { transportFromEnv } = await import("@/lib/mail/transport");

  // Said once here, rather than by the mail job every minute.
  if (!transportFromEnv()) {
    console.log("scheduled jobs: no BREVO_API_KEY / MAIL_FROM, so mail stays queued");
  }

  startLoop(async () => {
    for (const report of await runDueJobs(defaultJobs())) {
      if (report.status === "failed") {
        console.error(`job ${report.name} failed: ${report.error}`);
      } else if (report.status === "ok" && worthLogging(report.result)) {
        console.log(`job ${report.name}: ${JSON.stringify(report.result)}`);
      }
    }
  });

  console.log("scheduled jobs: started");
}

/** A run that found nothing, or skipped for a reason already logged, is not news. */
function worthLogging(result: Record<string, unknown>): boolean {
  return !("skipped" in result) && Object.values(result).some((value) => value !== 0);
}
