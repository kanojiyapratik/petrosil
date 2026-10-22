/**
 * How the driver is configured, which differs by where it runs.
 *
 * One pool of ten is right for a long-lived Node server and wrong for
 * functions: each instance opens its own pool, dozens of instances exhaust
 * Postgres, and the symptom is "sorry, too many clients already" under load
 * — which is exactly what a dev server with leaked pools did on this machine
 * today, on one process.
 *
 * And a pooled endpoint (PgBouncer, which is what Neon puts in front of
 * Postgres) cannot carry prepared statements across transaction-pooled
 * connections, so they have to be off.
 */
import { describe, expect, it } from "vitest";

import { databaseUrl, poolOptions } from "@/db/pool";

const LOCAL = "postgres://petrosil:petrosil@127.0.0.1:5434/petrosil";
const POOLED = "postgres://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/db";
const DIRECT = "postgres://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/db";

describe("the pool a long-lived server wants", () => {
  it("keeps a real pool when nothing says otherwise", () => {
    expect(poolOptions({ DATABASE_URL: LOCAL })).toMatchObject({ max: 10 });
  });

  it("leaves prepared statements on, because they are a straight win", () => {
    expect(poolOptions({ DATABASE_URL: LOCAL }).prepare).not.toBe(false);
  });
});

describe("the pool a function wants", () => {
  it("opens one connection per instance on Netlify", () => {
    expect(poolOptions({ DATABASE_URL: POOLED, NETLIFY: "true" })).toMatchObject({ max: 1 });
  });

  it("does the same anywhere else that announces itself as serverless", () => {
    expect(poolOptions({ DATABASE_URL: POOLED, VERCEL: "1" })).toMatchObject({ max: 1 });
    expect(poolOptions({ DATABASE_URL: POOLED, AWS_LAMBDA_FUNCTION_NAME: "f" })).toMatchObject({
      max: 1,
    });
  });
});

describe("talking through a connection pooler", () => {
  it("turns prepared statements off, because they do not survive it", () => {
    expect(poolOptions({ DATABASE_URL: POOLED }).prepare).toBe(false);
  });

  it("leaves them on against the direct endpoint of the same database", () => {
    expect(poolOptions({ DATABASE_URL: DIRECT }).prepare).not.toBe(false);
  });

  it("decides on the URL, not on the platform", () => {
    // A function talking to a direct endpoint still needs one connection, and
    // a server talking through a pooler still cannot prepare.
    expect(poolOptions({ DATABASE_URL: DIRECT, NETLIFY: "true" })).toMatchObject({ max: 1 });
    expect(poolOptions({ DATABASE_URL: DIRECT, NETLIFY: "true" }).prepare).not.toBe(false);
  });
});

/**
 * Which environment variable holds the connection string.
 *
 * Netlify Database provisions itself on first deploy and announces the result
 * as `NETLIFY_DATABASE_URL` (pooled) and `NETLIFY_DATABASE_URL_UNPOOLED`
 * (direct). This app has always read `DATABASE_URL`, so without a fallback a
 * deployed build would come up with a database sitting right there and no way
 * to reach it.
 */
describe("finding the database", () => {
  it("prefers DATABASE_URL, which is what a container and this laptop set", () => {
    expect(
      databaseUrl({ DATABASE_URL: LOCAL, NETLIFY_DATABASE_URL: POOLED }),
    ).toBe(LOCAL);
  });

  it("falls back to the one Netlify provisions", () => {
    expect(databaseUrl({ NETLIFY_DATABASE_URL: POOLED })).toBe(POOLED);
  });

  it("takes the pooled endpoint over the direct one for the app itself", () => {
    // Functions want the pooler. The unpooled URL is for migrations, which
    // run from a laptop and set DATABASE_URL explicitly.
    expect(
      databaseUrl({ NETLIFY_DATABASE_URL: POOLED, NETLIFY_DATABASE_URL_UNPOOLED: DIRECT }),
    ).toBe(POOLED);
  });

  it("uses the direct one if that is all there is", () => {
    expect(databaseUrl({ NETLIFY_DATABASE_URL_UNPOOLED: DIRECT })).toBe(DIRECT);
  });

  it("says which names it looked for when it finds none", () => {
    expect(() => databaseUrl({})).toThrow(/DATABASE_URL/);
  });
});

describe("the two decisions agree about which URL they are looking at", () => {
  it("spots the pooler in the URL Netlify provisions, not only in DATABASE_URL", () => {
    // The first cut of poolOptions read DATABASE_URL alone. On Netlify that
    // is unset, so it would have left prepared statements on against a
    // transaction pooler -- precisely what it exists to prevent.
    expect(poolOptions({ NETLIFY_DATABASE_URL: POOLED, NETLIFY: "true" }).prepare).toBe(false);
  });

  it("still leaves them on for the unpooled Netlify endpoint", () => {
    expect(
      poolOptions({ NETLIFY_DATABASE_URL_UNPOOLED: DIRECT, NETLIFY: "true" }).prepare,
    ).not.toBe(false);
  });

  it("does not fall over when there is no database configured at all", () => {
    // poolOptions is read before anything connects, so it must not throw the
    // way databaseUrl deliberately does.
    expect(() => poolOptions({})).not.toThrow();
  });
});
