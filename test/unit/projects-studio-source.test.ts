import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryProjectSource } from "../../src/projects/studio-source.js";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { UnreadableSecretError } from "../../src/studio/projects-source.js";

const secretKey = deriveSecretKey("s".repeat(32));

let dataDir: string;
let db: Registry;
let boxId: number;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-source-"));
  db = openRegistry(dataDir);
  boxId = insertBox(db, {
    name: "supabase",
    kind: "registered",
    devOnly: false,
    host: "aws-0.pooler.supabase.com",
    port: 5432,
    adminUser: "postgres.abc",
    adminPasswordEnc: encryptSecret("admin", secretKey),
    sslmode: "require",
    publicHost: "aws-0.pooler.supabase.com",
    publicPort: 5432,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
    adminSuperuser: false,
  }).id;
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function attach(passwordEnc: string) {
  insertProject(db, {
    ref: "shop",
    name: "Shop",
    boxId,
    dbName: "shop",
    ownerRole: "shop_app",
    ownerPasswordEnc: passwordEnc,
    kind: "attached",
    loginSuperuser: false,
  });
}

describe("RegistryProjectSource for an attached project", () => {
  it("reports the login verbatim, without the pooler suffix", async () => {
    attach(encryptSecret("login-pw", secretKey));
    const source = new RegistryProjectSource(db, secretKey);

    const project = await source.get("admin", "shop");
    expect(project?.ownerRole).toBe("shop_app");
    expect(project?.ownerPassword()).toBe("login-pw");
    expect((await source.list("admin"))[0]?.ownerRole).toBe("shop_app");
  });

  it("points at the login when its password cannot be decrypted", async () => {
    attach(encryptSecret("login-pw", deriveSecretKey("x".repeat(32))));
    const project = await new RegistryProjectSource(db, secretKey).get("admin", "shop");

    expect(() => project?.ownerPassword()).toThrow(UnreadableSecretError);
    expect(() => project?.ownerPassword()).toThrow(
      /Update its login on its hattisar project page\.$/,
    );
  });
});
