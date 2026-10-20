import CryptoJS from "crypto-js";
import { describe, expect, it } from "vitest";
import { encryptConnectionString } from "../../src/studio/crypto.js";

const key = "a-shared-pg-meta-crypto-key";
const connection = "postgresql://supabase_admin:p%40ss@db:5432/spike_b";

describe("encryptConnectionString", () => {
  it("decrypts with crypto-js passphrase mode to the input", () => {
    const encrypted = encryptConnectionString(connection, key);
    expect(CryptoJS.AES.decrypt(encrypted, key).toString(CryptoJS.enc.Utf8)).toBe(connection);
  });

  it("emits OpenSSL salted output", () => {
    const encrypted = encryptConnectionString(connection, key);
    expect(Buffer.from(encrypted, "base64").subarray(0, 8).toString("latin1")).toBe("Salted__");
  });

  it("salts every call", () => {
    expect(encryptConnectionString(connection, key)).not.toBe(
      encryptConnectionString(connection, key),
    );
  });
});
