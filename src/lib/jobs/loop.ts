/**
 * The timer that ticks the scheduler inside the server.
 *
 * Each tick schedules the next only when it has finished, so a long tick
 * delays the next one instead of overlapping it. The handle lives on
 * `globalThis` because `next dev` re-evaluates modules on reload while the
 * process — and any timer it started — carries on.
 */

type Tick = () => Promise<void>;

type LoopOptions = {
  intervalMs?: number;
  /** Delay before the first tick, so a booting server answers requests first. */
  firstTickMs?: number;
  log?: (message: string) => void;
};

type Loop = { timer: ReturnType<typeof setTimeout> | undefined; stopped: boolean };

const KEY = Symbol.for("petrosil.jobs.loop");
const registry = globalThis as typeof globalThis & { [KEY]?: Loop };

export function startLoop(tick: Tick, options: LoopOptions = {}): void {
  if (registry[KEY] && !registry[KEY].stopped) {
    return;
  }

  const intervalMs = options.intervalMs ?? 60_000;
  const log = options.log ?? ((message: string) => console.error(message));
  const loop: Loop = { timer: undefined, stopped: false };

  registry[KEY] = loop;

  const next = (delay: number) => {
    if (loop.stopped) {
      return;
    }

    loop.timer = setTimeout(async () => {
      try {
        await tick();
      } catch (error) {
        log(`scheduled jobs: tick failed: ${error instanceof Error ? error.message : error}`);
      }

      next(intervalMs);
    }, delay);

    // Never the reason a process stays alive: scripts and tests must exit.
    loop.timer.unref?.();
  };

  next(options.firstTickMs ?? 15_000);
}

export function stopLoop(): void {
  const loop = registry[KEY];

  if (loop) {
    loop.stopped = true;
    clearTimeout(loop.timer);
    registry[KEY] = undefined;
  }
}
