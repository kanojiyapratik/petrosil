/**
 * End the terms that have run out.
 *
 *   npm run sweep:expiries
 *
 * Put this on a daily schedule. The old estate ran the same job by visiting
 * `admin/artisan/subscription` in a browser, which meant it ran when someone
 * remembered. It is safe to run more than once a day: a membership already
 * dropped to free is no longer due, so a second pass finds nothing.
 */

import { closeDb } from "@/db";
import { sweepExpiries } from "@/domain/billing/sweep";

async function main(): Promise<void> {
  const { lapsed } = await sweepExpiries();

  console.log(
    lapsed === 0
      ? "nothing had run out."
      : `${lapsed} membership(s) dropped to free. The expiry date stays on the row.`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    await closeDb();
    process.exit(1);
  });
