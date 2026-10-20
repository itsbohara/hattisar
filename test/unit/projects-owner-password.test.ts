import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateOwnerPassword, scramVerifier } from "../../src/projects/owner-password.js";

describe("generateOwnerPassword", () => {
  it("is 32 random bytes in base64url", () => {
    const password = generateOwnerPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(password, "base64url")).toHaveLength(32);
    expect(generateOwnerPassword()).not.toBe(password);
  });
});

describe("scramVerifier", () => {
  it("builds Postgres's SCRAM-SHA-256 verifier from password and salt", () => {
    const salt = Buffer.from("0123456789abcdef");
    const salted = pbkdf2Sync("pencil", salt, 4096, 32, "sha256");
    const storedKey = createHash("sha256")
      .update(createHmac("sha256", salted).update("Client Key").digest())
      .digest("base64");
    const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");

    expect(scramVerifier("pencil", salt)).toBe(
      `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`,
    );
  });

  it("never contains the password", () => {
    const password = generateOwnerPassword();
    expect(scramVerifier(password)).not.toContain(password);
  });
});
