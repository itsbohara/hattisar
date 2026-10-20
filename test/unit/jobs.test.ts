import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler, type TimerApi } from "../../src/jobs.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");

class FakeTimers implements TimerApi {
  readonly active = new Map<number, { run: () => void; ms: number }>();
  private next = 1;

  setInterval(run: () => void, ms: number): number {
    const id = this.next++;
    this.active.set(id, { run, ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.active.delete(handle as number);
  }

  fire(ms: number): void {
    for (const timer of this.active.values()) if (timer.ms === ms) timer.run();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Scheduler", () => {
  it("runs each started job on its own interval with the injected clock", async () => {
    const timers = new FakeTimers();
    const scheduler = new Scheduler(() => NOW, timers);
    const seen: string[] = [];
    scheduler.register("purge", 3_600_000, async (now) => {
      seen.push(`purge@${now.toISOString()}`);
    });
    scheduler.register("other", 60_000, async () => {
      seen.push("other");
    });

    timers.fire(3_600_000);
    expect(seen).toEqual([]);

    scheduler.start();
    timers.fire(3_600_000);
    await vi.waitFor(() => expect(seen).toEqual([`purge@${NOW.toISOString()}`]));

    scheduler.stop();
    expect(timers.active.size).toBe(0);
  });

  it("never overlaps two runs of the same job", async () => {
    const scheduler = new Scheduler(() => NOW, new FakeTimers());
    const gate = deferred();
    let runs = 0;
    scheduler.register("slow", 1_000, async () => {
      runs += 1;
      await gate.promise;
    });

    const first = scheduler.runNow("slow");
    expect(await scheduler.runNow("slow")).toBe("skipped");
    gate.resolve();
    expect(await first).toBe("ran");
    expect(await scheduler.runNow("slow")).toBe("ran");
    expect(runs).toBe(2);
  });

  it("logs a failing job by name without the error's message and keeps scheduling it", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      logged.push(line);
    });
    const scheduler = new Scheduler(() => NOW, new FakeTimers());
    let calls = 0;
    scheduler.register("purge", 1_000, async () => {
      calls += 1;
      throw new Error("password=hunter2-secret");
    });

    expect(await scheduler.runNow("purge")).toBe("failed");
    expect(await scheduler.runNow("purge")).toBe("failed");
    expect(calls).toBe(2);
    expect(logged[0]).toMatch(/^hattisar: job purge failed: Error/);
    expect(logged.join("\n")).not.toContain("hunter2-secret");
  });

  it("refuses a second job with the same name", () => {
    const scheduler = new Scheduler(() => NOW, new FakeTimers());
    scheduler.register("purge", 1_000, async () => {});
    expect(() => scheduler.register("purge", 1_000, async () => {})).toThrow(
      "job purge is already registered",
    );
  });
});
