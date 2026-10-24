import type { Config } from "../config.js";
import { getSharedBox, insertBox, updateBox } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { encryptSecret } from "../registry/secrets.js";

export const SHARED_BOX_NAME = "shared";

// Env is the source of truth for the shared box: every boot rewrites its env-derived fields.
export function seedSharedBox(db: Registry, config: Config, secretKey: Buffer): void {
  const fromEnv = {
    adminPasswordEnc: encryptSecret(config.postgresPassword, secretKey),
    publicHost: config.publicHost,
    publicPort: config.pooler.portSession,
    poolerTenant: config.pooler.tenantId,
    poolerSessionPort: config.pooler.portSession,
    poolerTransactionPort: config.pooler.portTransaction,
  };
  const existing = getSharedBox(db);
  if (existing) {
    updateBox(db, existing.id, fromEnv);
    return;
  }
  insertBox(db, {
    name: SHARED_BOX_NAME,
    kind: "shared",
    devOnly: true,
    host: "db",
    port: 5432,
    adminUser: "supabase_admin",
    sslmode: "disable",
    containerName: null,
    ...fromEnv,
  });
}
