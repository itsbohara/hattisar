import pg from "pg";
import { ignoreIdleErrors } from "../boxes/admin-client.js";
import { SHARED_POOLER } from "../boxes/shared.js";
import type { Box } from "../registry/boxes.js";
import type { Project } from "../registry/projects.js";

export type PoolerRefresher = (
  box: Box,
  project: Pick<Project, "ref" | "dbName" | "ownerRole">,
  password: string,
) => Promise<void>;

async function tryConnect(config: pg.ClientConfig): Promise<boolean> {
  const client = ignoreIdleErrors(new pg.Client(config));
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

// Supavisor caches each user's auth secret and only refetches it after a login fails against the
// cache. Until then a rotated-out password keeps working through the pooler and the first login
// with the new one is refused. One login with the new password (refused once, then accepted)
// brings the cache up to date. Best effort: the password change itself has already happened.
export const refreshSharedPooler: PoolerRefresher = async (box, project, password) => {
  if (box.kind !== "shared" || box.poolerTenant === null) return;
  const config: pg.ClientConfig = {
    ...SHARED_POOLER,
    user: `${project.ownerRole}.${box.poolerTenant}`,
    password,
    database: project.dbName,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  };
  if ((await tryConnect(config)) || (await tryConnect(config))) return;
  console.warn(`hattisar: pooler did not accept the new owner password for ${project.ref} yet`);
};
