const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

// In-memory by design (spec §6): a restart clears it.
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  isBlocked(username: string): boolean {
    return this.recent(username).length >= MAX_FAILURES;
  }

  recordFailure(username: string): void {
    this.failures.set(username, [...this.recent(username), this.now()]);
  }

  recordSuccess(username: string): void {
    this.failures.delete(username);
  }

  private recent(username: string): number[] {
    const since = this.now() - WINDOW_MS;
    for (const [name, times] of this.failures) {
      if (times.every((time) => time <= since)) this.failures.delete(name);
    }
    return (this.failures.get(username) ?? []).filter((time) => time > since);
  }
}
