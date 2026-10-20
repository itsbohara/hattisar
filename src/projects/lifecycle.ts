import pg from "pg";
import { safeErrorMessage } from "../boxes/admin-client.js";
import { boxConnection } from "../boxes/service.js";
import { type Box, getBoxById } from "../registry/boxes.js";
import {
  deleteProject,
  listProjectsDeletedBefore,
  markProjectDeleted,
  markProjectRestored,
  type Project,
} from "../registry/projects.js";
import { deletedDbNameFor } from "./naming.js";
import type { ProjectServiceDeps } from "./service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type LifecycleResult = { ok: true } | { ok: false; problem: string };

async function inTransaction(client: pg.Client, run: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await run();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

// One transaction, so a failed rename leaves the owner able to connect as before.
export async function softDeleteProject(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
  now: Date = new Date(),
): Promise<LifecycleResult> {
  const conn = boxConnection(box, deps.secretKey);
  const db = pg.escapeIdentifier(project.dbName);
  const role = pg.escapeIdentifier(project.ownerRole);
  let deletedDbName = "";
  try {
    await deps.admin(conn, (client) =>
      inTransaction(client, async () => {
        await client.query(`REVOKE CONNECT ON DATABASE ${db} FROM ${role}`);
        await client.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [project.dbName],
        );
        const taken = await client.query<{ datname: string }>(
          "select datname from pg_database where starts_with(datname, $1)",
          [`${project.dbName}__deleted_`],
        );
        deletedDbName = deletedDbNameFor(
          project.dbName,
          now,
          taken.rows.map((row) => row.datname),
        );
        await client.query(`ALTER DATABASE ${db} RENAME TO ${pg.escapeIdentifier(deletedDbName)}`);
        await client.query(`ALTER ROLE ${role} NOLOGIN`);
      }),
    );
  } catch (error) {
    return {
      ok: false,
      problem: `Could not delete the project: ${safeErrorMessage(error, conn.password)}`,
    };
  }
  markProjectDeleted(deps.db, project.id, deletedDbName, now.toISOString());
  await deps.onLifecycle?.(box, project, "deleted");
  return { ok: true };
}

export async function restoreProject(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
): Promise<LifecycleResult> {
  if (project.deletedDbName === null) return { ok: false, problem: "Project is not deleted" };
  const conn = boxConnection(box, deps.secretKey);
  const db = pg.escapeIdentifier(project.dbName);
  const role = pg.escapeIdentifier(project.ownerRole);
  const deletedDb = pg.escapeIdentifier(project.deletedDbName);
  try {
    await deps.onLifecycle?.(box, project, "restoring");
    await deps.admin(conn, (client) =>
      inTransaction(client, async () => {
        await client.query(`ALTER DATABASE ${deletedDb} RENAME TO ${db}`);
        await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
        await client.query(`ALTER ROLE ${role} LOGIN`);
      }),
    );
  } catch (error) {
    return {
      ok: false,
      problem: `Could not restore the project: ${safeErrorMessage(error, conn.password)}`,
    };
  }
  markProjectRestored(deps.db, project.id);
  return { ok: true };
}

// Anything the owner role owns or holds a grant on outside the project's own database, which
// would make DROP ROLE fail after the database is already gone.
const FOREIGN_DEPENDENCIES = `
  select coalesce(d.datname, 'the cluster') as place
    from pg_shdepend s
    left join pg_database d on d.oid = s.dbid
   where s.refclassid = 'pg_authid'::regclass
     and s.refobjid = (select oid from pg_roles where rolname = $1)
     and case
           when s.dbid = 0 then not (s.classid = 'pg_database'::regclass
                                     and s.objid is not distinct from (select oid from pg_database where datname = $2))
           else s.dbid is distinct from (select oid from pg_database where datname = $2)
         end
   group by 1 order by 1`;

export async function purgeProject(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
): Promise<LifecycleResult> {
  if (project.deletedDbName === null) return { ok: false, problem: "Project is not deleted" };
  const deletedDbName = project.deletedDbName;
  const conn = boxConnection(box, deps.secretKey);
  try {
    await deps.admin(conn, async (client) => {
      const foreign = await client.query<{ place: string }>(FOREIGN_DEPENDENCIES, [
        project.ownerRole,
        deletedDbName,
      ]);
      if (foreign.rowCount !== 0) {
        const places = foreign.rows.map((row) => row.place).join(", ");
        throw new Error(
          `role ${project.ownerRole} still owns objects or holds privileges in ${places}; nothing was dropped`,
        );
      }
      await client.query(
        `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(deletedDbName)} WITH (FORCE)`,
      );
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(project.ownerRole)}`);
    });
  } catch (error) {
    return {
      ok: false,
      problem: `Could not purge the project: ${safeErrorMessage(error, conn.password)}`,
    };
  }
  deleteProject(deps.db, project.id);
  await deps.onLifecycle?.(box, project, "purged");
  return { ok: true };
}

export async function purgeExpiredProjects(
  deps: ProjectServiceDeps,
  purgeAfterDays: number,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - purgeAfterDays * DAY_MS).toISOString();
  for (const project of listProjectsDeletedBefore(deps.db, cutoff)) {
    const box = getBoxById(deps.db, project.boxId);
    if (box === undefined) continue;
    const result = await purgeProject(deps, project, box);
    if (!result.ok) {
      console.error(`hattisar: auto-purge of ${project.ref} failed: ${result.problem}`);
    }
  }
}

export function purgeDate(project: Project, purgeAfterDays: number): Date | undefined {
  if (project.deletedAt === null) return undefined;
  return new Date(Date.parse(project.deletedAt) + purgeAfterDays * DAY_MS);
}
