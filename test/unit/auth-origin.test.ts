import { describe, expect, it } from "vitest";
import { isSameOrigin } from "../../src/auth/origin.js";

function check(host: string, values: Record<string, string>): boolean {
  return isSameOrigin(new Headers(values), host);
}

describe("origin check", () => {
  it("accepts an Origin matching the host", () => {
    expect(check("hattisar.test:8000", { origin: "http://hattisar.test:8000" })).toBe(true);
  });

  it("accepts a Referer matching the host when Origin is absent", () => {
    expect(check("hattisar.test", { referer: "https://hattisar.test/_hs/settings" })).toBe(true);
  });

  it("rejects a foreign Origin even when the Referer matches", () => {
    expect(
      check("hattisar.test", {
        origin: "https://evil.test",
        referer: "https://hattisar.test/_hs/settings",
      }),
    ).toBe(false);
  });

  it("rejects a different port", () => {
    expect(check("hattisar.test:8000", { origin: "http://hattisar.test:9000" })).toBe(false);
  });

  it.each([[{}], [{ origin: "null" }], [{ referer: "not a url" }]])("rejects %j", (values) => {
    expect(check("hattisar.test", values)).toBe(false);
  });
});
