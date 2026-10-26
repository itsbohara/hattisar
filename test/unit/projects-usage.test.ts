import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminClientRunner, BoxConnection } from "../../src/boxes/admin-client.js";
import type { ProjectAndBox } from "../../src/projects/access.js";
import { projectUsage } from "../../src/projects/usage.js";
import { type Box, insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";

const secretKey = deriveSecretKey("u".repeat(32));

interface Call {
  conn: BoxConnection;
  database: string | undefined;
  params: unknown;
}

let dataDir: string;
let db: Registry;
let box: Box;
let rows: ProjectAndBox[];
let calls: Call[];
let loginFails: boolean;

const fakeAdmin: AdminClientRunner = async (conn, run, database) => {
  const call: Call = { conn, database, params: undefined };
  calls.push(call);
  const client = {
    query: async (_text: string, params: string[][]) => {
      call.params = params[0];
      if (conn.user === "shop_app") {
        if (loginFails) throw new Error("password authentication failed");
        return { rows: [{ datname: "shop", bytes: "700" }] };
      }
      return { rows: [{ datname: "made", bytes: "300" }] };
    },
  };
  return run(client as unknown as pg.Client);
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-usage-"));
  db = openRegistry(dataDir);
  box = insertBox(db, {
    name: "rds",
    kind: "registered",
    devOnly: false,
    host: "pg.internal",
    port: 5433,
    adminUser: "rdsadmin",
    adminPasswordEnc: encryptSecret("admin-pw", secretKey),
    sslmode: "require",
    publicHost: "pg.example.test",
    publicPort: 5433,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
    adminSuperuser: false,
  });
  const created = insertProject(db, {
    ref: "made",
    name: "Made",
    boxId: box.id,
    dbName: "made",
    ownerRole: "hs_made_owner",
    ownerPasswordEnc: encryptSecret("owner-pw", secretKey),
  });
  const attached = insertProject(db, {
    ref: "shop",
    name: "Shop",
    boxId: box.id,
    dbName: "shop",
    ownerRole: "shop_app",
    ownerPasswordEnc: encryptSecret("login-pw", secretKey),
    kind: "attached",
    loginSuperuser: false,
  });
  rows = [
    { project: created, box },
    { project: attached, box },
  ];
  calls = [];
  loginFails = false;
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("projectUsage", () => {
  it("sizes created projects with the admin and attached ones with their login", async () => {
    const usage = await projectUsage({ secretKey, admin: fakeAdmin }, rows);

    const adminCall = calls.find((call) => call.conn.user === "rdsadmin");
    expect(adminCall?.params).toEqual(["made"]);
    const loginCall = calls.find((call) => call.conn.user === "shop_app");
    expect(loginCall).toMatchObject({ database: "shop", params: ["shop"] });
    expect(loginCall?.conn.password).toBe("login-pw");
    expect(usage).toEqual({
      boxes: { [box.id]: { reachable: true, bytes: 1000 } },
      projects: { made: 300, shop: 700 },
    });
  });

  it("leaves only the attached project unsized when its login fails", async () => {
    loginFails = true;
    const usage = await projectUsage({ secretKey, admin: fakeAdmin }, rows);

    expect(usage).toEqual({
      boxes: { [box.id]: { reachable: true, bytes: 300 } },
      projects: { made: 300 },
    });
  });
});
