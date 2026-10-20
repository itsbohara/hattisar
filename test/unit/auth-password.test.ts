import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/password.js";

describe("password hashing", () => {
  it("uses scrypt with the spec's parameters, a 16-byte salt and a 64-byte key", async () => {
    const hash = await hashPassword("correct horse battery");
    const [scheme, n, r, p, salt, key, ...rest] = hash.split("$");
    expect(rest).toEqual([]);
    expect([scheme, n, r, p]).toEqual(["scrypt", "32768", "8", "1"]);
    expect(Buffer.from(salt ?? "", "base64")).toHaveLength(16);
    expect(Buffer.from(key ?? "", "base64")).toHaveLength(64);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("verifies the right password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse batterz", hash)).toBe(false);
  });

  it.each([
    "",
    "bcrypt$32768$8$1$c2FsdA==$a2V5",
    "scrypt$32768$8$1$c2FsdA==",
    "scrypt$abc$8$1$c2FsdA==$a2V5",
  ])("rejects a malformed stored hash %j", async (stored) => {
    expect(await verifyPassword("anything", stored)).toBe(false);
  });
});
