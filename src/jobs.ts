export type Job = (now: Date) => Promise<void>;

export type JobOutcome = "ran" | "skipped" | "failed";

export interface TimerApi {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

// unref: a pending job tick must not keep the process alive after the server closes.
const nodeTimers: TimerApi = {
  setInterval: (run, ms) => setInterval(run, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

interface Registered {
  intervalMs: number;
  run: Job;
  running: boolean;
}

// Logs the error's class and stack frames but not its message: a job handles box credentials.
function logFailure(name: string, error: unknown): void {
  const failure = error instanceof Error ? error : new Error("non-Error thrown");
  const frames = (failure.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  console.error([`hattisar: job ${name} failed: ${failure.name}`, ...frames].join("\n"));
}

export class Scheduler {
  private readonly jobs = new Map<string, Registered>();
  private readonly handles: unknown[] = [];

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly timers: TimerApi = nodeTimers,
  ) {}

  register(name: string, intervalMs: number, run: Job): void {
    if (this.jobs.has(name)) throw new Error(`job ${name} is already registered`);
    this.jobs.set(name, { intervalMs, run, running: false });
  }

  start(): void {
    for (const [name, job] of this.jobs) {
      this.handles.push(this.timers.setInterval(() => void this.runNow(name), job.intervalMs));
    }
  }

  stop(): void {
    for (const handle of this.handles.splice(0)) this.timers.clearInterval(handle);
  }

  async runNow(name: string): Promise<JobOutcome> {
    const job = this.jobs.get(name);
    if (job === undefined) throw new Error(`job ${name} is not registered`);
    if (job.running) return "skipped";
    job.running = true;
    try {
      await job.run(this.clock());
      return "ran";
    } catch (error) {
      logFailure(name, error);
      return "failed";
    } finally {
      job.running = false;
    }
  }
}
