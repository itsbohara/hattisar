import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "../../src/auth/rate-limit.js";

const MINUTE = 60_000;

function limiterAt(start = 0) {
  let now = start;
  const limiter = new LoginRateLimiter(() => now);
  return {
    limiter,
    advance(ms: number) {
      now += ms;
    },
  };
}

function fail(limiter: LoginRateLimiter, username: string, times: number): void {
  for (let i = 0; i < times; i++) limiter.recordFailure(username);
}

describe("login rate limit", () => {
  it("allows four failures and blocks after the fifth", () => {
    const { limiter } = limiterAt();
    fail(limiter, "admin", 4);
    expect(limiter.isBlocked("admin")).toBe(false);
    fail(limiter, "admin", 1);
    expect(limiter.isBlocked("admin")).toBe(true);
  });

  it("counts per username", () => {
    const { limiter } = limiterAt();
    fail(limiter, "admin", 5);
    expect(limiter.isBlocked("someone-else")).toBe(false);
  });

  it("blocks until the 15-minute window passes", () => {
    const { limiter, advance } = limiterAt();
    fail(limiter, "admin", 5);
    advance(15 * MINUTE - 1);
    expect(limiter.isBlocked("admin")).toBe(true);
    advance(1);
    expect(limiter.isBlocked("admin")).toBe(false);
  });

  it("forgets failures older than the window", () => {
    const { limiter, advance } = limiterAt();
    fail(limiter, "admin", 4);
    advance(15 * MINUTE);
    fail(limiter, "admin", 1);
    expect(limiter.isBlocked("admin")).toBe(false);
  });

  it("clears a username's failures on success", () => {
    const { limiter } = limiterAt();
    fail(limiter, "admin", 4);
    limiter.recordSuccess("admin");
    fail(limiter, "admin", 4);
    expect(limiter.isBlocked("admin")).toBe(false);
  });
});
