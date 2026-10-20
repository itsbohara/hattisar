import { describe, expect, it } from "vitest";
import { dbNameFor, ownerRoleFor, refProblem, slugify } from "../../src/projects/naming.js";

describe("refProblem", () => {
  it.each(["abc", "my-app", "a12", "a".repeat(40), "default"])("accepts %s", (ref) => {
    expect(refProblem(ref)).toBeUndefined();
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(41)],
    ["starting with a digit", "1abc"],
    ["starting with a hyphen", "-abc"],
    ["uppercase", "MyApp"],
    ["an underscore", "my_app"],
    ["a quote", 'a"b; drop role x'],
    ["empty", ""],
  ])("rejects a ref that is %s", (_label, ref) => {
    expect(refProblem(ref)).toBe(
      "Ref must be 3-40 characters: lowercase letters, digits and hyphens, starting with a letter",
    );
  });

  it("reserves the new-project page's path segment", () => {
    expect(refProblem("new")).toBe('Ref "new" is reserved');
  });
});

describe("naming", () => {
  it("derives the database name by replacing hyphens", () => {
    expect(dbNameFor("my-cool-app")).toBe("my_cool_app");
  });

  it("derives the owner role from the database name", () => {
    expect(ownerRoleFor("my_cool_app")).toBe("hs_my_cool_app_owner");
  });

  it("keeps the longest owner role within Postgres's 63-byte identifier limit", () => {
    expect(ownerRoleFor(dbNameFor(`a${"-".repeat(39)}`)).length).toBeLessThanOrEqual(63);
  });
});

describe("slugify", () => {
  it.each([
    ["My Cool App", "my-cool-app"],
    ["  Spaces  everywhere ", "spaces-everywhere"],
    ["Ünïcödé Shop", "unicode-shop"],
    ["2024 report", "report"],
    ["a__b..c", "a-b-c"],
    ["x".repeat(60), "x".repeat(40)],
    ["ab-", "ab"],
    ["", ""],
  ])("turns %j into %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});
