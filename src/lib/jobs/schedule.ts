/**
 * When a job is due.
 *
 * A job is due when it last started before its cutoff — the moment the
 * current slot opened. Both shapes reduce to that one comparison, which is
 * also what the claim in `runner.ts` writes into its WHERE clause.
 */

export type Schedule = { everyMinutes: number } | { dailyAt: string };

/** India has no daylight saving, so a fixed offset is exact. */
const INDIA_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * The loop ticks once a minute and timers drift; without some slack a
 * one-minute job whose tick lands a moment early would skip a whole minute.
 */
const SLACK_MS = 5_000;

export function dueCutoff(schedule: Schedule, now: Date): Date {
  if ("everyMinutes" in schedule) {
    return new Date(now.getTime() - schedule.everyMinutes * 60_000 + SLACK_MS);
  }

  const [hours, minutes] = schedule.dailyAt.split(":").map(Number) as [number, number];

  // Today's slot, worked out on India's calendar and then moved back to UTC.
  const india = new Date(now.getTime() + INDIA_OFFSET_MINUTES * 60_000);
  const slot = new Date(
    Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate(), hours, minutes) -
      INDIA_OFFSET_MINUTES * 60_000,
  );

  // Before today's slot, the slot that counts is yesterday's.
  return slot.getTime() <= now.getTime() ? slot : new Date(slot.getTime() - 24 * 60 * 60_000);
}

export function isDue(schedule: Schedule, lastStartedAt: Date | null, now: Date): boolean {
  return lastStartedAt === null || lastStartedAt.getTime() < dueCutoff(schedule, now).getTime();
}
