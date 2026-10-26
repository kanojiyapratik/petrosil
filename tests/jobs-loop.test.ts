/**
 * The loop that ticks the scheduler inside the server process.
 *
 * Two rules: a tick that runs long must not have another start on top of it,
 * and starting the loop twice — which `next dev` does on every reload — must
 * not leave two loops running.
 */
import { afterEach, describe, expect, it } from "vitest";

import { startLoop, stopLoop } from "@/lib/jobs/loop";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  stopLoop();
});

describe("the scheduler loop", () => {
  it("ticks on its interval", async () => {
    let ticks = 0;

    startLoop(async () => {
      ticks++;
    }, { intervalMs: 20, firstTickMs: 0 });

    await wait(110);

    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it("never starts a tick while the last one is still running", async () => {
    let running = 0;
    let overlapped = false;

    startLoop(async () => {
      running++;
      overlapped ||= running > 1;
      await wait(60);
      running--;
    }, { intervalMs: 10, firstTickMs: 0 });

    await wait(200);

    expect(overlapped).toBe(false);
  });

  it("keeps one loop when started twice", async () => {
    let first = 0;
    let second = 0;

    startLoop(async () => {
      first++;
    }, { intervalMs: 20, firstTickMs: 0 });
    startLoop(async () => {
      second++;
    }, { intervalMs: 20, firstTickMs: 0 });

    await wait(80);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it("survives a tick that throws", async () => {
    let ticks = 0;

    startLoop(async () => {
      ticks++;
      throw new Error("boom");
    }, { intervalMs: 20, firstTickMs: 0, log: () => {} });

    await wait(90);

    expect(ticks).toBeGreaterThanOrEqual(2);
  });
});
