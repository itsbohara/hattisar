import { describe, expect, it } from "vitest";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";

const key = deriveSecretKey("a-hattisar-secret-key-of-32-chars-or-more");
const plaintext = "s3cr3t-owner-password";

function replacePart(stored: string, index: number, replace: (part: Buffer) => Buffer): string {
  const parts = stored.split(":");
  parts[index] = replace(Buffer.from(parts[index] ?? "", "base64")).toString("base64");
  return parts.join(":");
}

function flipFirstByte(part: Buffer): Buffer {
  const copy = Buffer.from(part);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}

describe("secrets", () => {
  it("round-trips", () => {
    expect(decryptSecret(encryptSecret(plaintext, key), key)).toBe(plaintext);
  });

  it("round-trips an empty and a unicode secret", () => {
    for (const value of ["", "पासवर्ड:with:colons"]) {
      expect(decryptSecret(encryptSecret(value, key), key)).toBe(value);
    }
  });

  it("stores v1:<iv>:<tag>:<ciphertext> with a 12-byte iv and 16-byte tag", () => {
    const stored = encryptSecret(plaintext, key);
    const [version, iv, tag, ciphertext, ...rest] = stored.split(":");
    expect(version).toBe("v1");
    expect(rest).toHaveLength(0);
    expect(Buffer.from(iv ?? "", "base64")).toHaveLength(12);
    expect(Buffer.from(tag ?? "", "base64")).toHaveLength(16);
    expect(Buffer.from(ciphertext ?? "", "base64")).toHaveLength(Buffer.byteLength(plaintext));
    expect(stored).not.toContain(plaintext);
  });

  it("uses a fresh iv every call", () => {
    expect(encryptSecret(plaintext, key)).not.toBe(encryptSecret(plaintext, key));
  });

  it("derives a 32-byte key deterministically", () => {
    const secret = "another-hattisar-secret-key-32-chars";
    expect(deriveSecretKey(secret)).toHaveLength(32);
    expect(deriveSecretKey(secret).equals(deriveSecretKey(secret))).toBe(true);
  });

  it.each([
    ["ciphertext", 3],
    ["tag", 2],
    ["iv", 1],
  ])("throws when the %s is tampered with", (_name, index) => {
    const tampered = replacePart(encryptSecret(plaintext, key), index, flipFirstByte);
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("throws with the wrong key", () => {
    const stored = encryptSecret(plaintext, key);
    const wrongKey = deriveSecretKey("a-different-secret-key-of-32-chars-plus");
    expect(() => decryptSecret(stored, wrongKey)).toThrow();
  });

  it.each(["", "plain", "v2:aaaa:bbbb:cccc", "v1:only:three", "v1:a:b:c:d"])(
    "throws on malformed input %j",
    (stored) => {
      expect(() => decryptSecret(stored, key)).toThrow();
    },
  );

  it("never puts plaintext or ciphertext in the error", () => {
    const stored = encryptSecret(plaintext, key);
    const wrongKey = deriveSecretKey("a-different-secret-key-of-32-chars-plus");
    let message = "";
    try {
      decryptSecret(stored, wrongKey);
    } catch (error) {
      message = `${(error as Error).message} ${String((error as Error).cause ?? "")}`;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(plaintext);
    for (const part of stored.split(":").slice(1)) expect(message).not.toContain(part);
  });
});
