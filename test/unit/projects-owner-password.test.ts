import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  generateOwnerPassword,
  scramVerifier,
  setRolePassword,
} from "../../src/projects/owner-password.js";

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

describe("setRolePassword", () => {
  function fakeClient(refuse: (sql: string) => Error | undefined) {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        const error = refuse(text);
        if (error) throw error;
      },
    } as unknown as pg.Client;
    return { client, sql };
  }
  const statement = (literal: string) => `ALTER ROLE "r" PASSWORD ${literal}`;

  it("sends only the SCRAM verifier when the box accepts it", async () => {
    const { client, sql } = fakeClient(() => undefined);
    await setRolePassword(client, statement, "pencil");
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^ALTER ROLE "r" PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(sql[0]).not.toContain("pencil");
  });

  it("falls back to the plaintext when the box only takes plaintext (Neon)", async () => {
    const neon = new Error(
      'Received HTTP code 400 from control plane: {"error":"Neon only supports being given plaintext passwords"}',
    );
    const { client, sql } = fakeClient((text) => (text.includes("SCRAM") ? neon : undefined));
    await setRolePassword(client, statement, "pencil");
    expect(sql[1]).toBe(`ALTER ROLE "r" PASSWORD 'pencil'`);
  });

  it("rethrows any other failure without retrying", async () => {
    const { client, sql } = fakeClient(() => new Error("permission denied"));
    await expect(setRolePassword(client, statement, "pencil")).rejects.toThrow("permission denied");
    expect(sql).toHaveLength(1);
  });
});
