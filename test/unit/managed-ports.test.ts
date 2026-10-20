import { describe, expect, it } from "vitest";
import { pickPort } from "../../src/managed/ports.js";

const range = { start: 55000, end: 55003 };

describe("pickPort", () => {
  it("takes the start of the range when nothing is used", () => {
    expect(pickPort(range, [])).toBe(55000);
  });

  it("skips used ports and takes the first free one", () => {
    expect(pickPort(range, [55000, 55001, 55003])).toBe(55002);
  });

  it("ignores used ports outside the range", () => {
    expect(pickPort(range, [5432, 54999, 56000])).toBe(55000);
  });

  it("returns undefined when every port in the range is used", () => {
    expect(pickPort(range, [55003, 55002, 55001, 55000])).toBeUndefined();
  });

  it("handles a one-port range", () => {
    expect(pickPort({ start: 55500, end: 55500 }, [])).toBe(55500);
    expect(pickPort({ start: 55500, end: 55500 }, [55500])).toBeUndefined();
  });
});
