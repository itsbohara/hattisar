import { expect, it } from "vitest";
import { canAccess } from "../../src/auth/access.js";

it("lets the single admin access every project in v1", () => {
  const user = { id: 1, username: "admin" };
  expect(canAccess(user, { ref: "spike-a" })).toBe(true);
});
