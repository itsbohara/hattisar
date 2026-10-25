import pg from "pg";
import { type BoxConnection, safeErrorMessage } from "../boxes/admin-client.js";
import { boxConnection } from "../boxes/service.js";
import { type Box, getBoxById } from "../registry/boxes.js";
import {
  deleteProject,
  listProjectsDeletedBefore,
  markProjectDeleted,
  markProjectRestored,
  type Project,
} from "../registry/projects.js";
import { busyReason, holdingProject, type ProjectOperation } from "./locks.js";
import { deletedDbNameFor } from "./naming.js";
import { joinOwnerRole, type ProjectServiceDeps } from "./service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type LifecycleResult = { ok: true } | { ok: false; problem: string };

const DELETE: ProjectOperation = {
  action: "delete",
  holds: "it is being deleted",
  status: "active",
};
const UNDELETE: ProjectOperation = {
  action: "restore",
  holds: "it is being restored from Trash",
  status: "deleted",
};
const PURGE: ProjectOperation = { action: "purge", holds: "it is being purged", status: "deleted" };

const RENAME_ATTEMPTS = 3;
const OBJECT_IN_USE = "55006";

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

// Decrypting the box password can throw too, so it happens inside the same error handling as the SQL.
async function onBox(
  deps: ProjectServiceDeps,
  box: Box,
  action: string,
  run: (conn: BoxConnection) => Promise<void>,
): Promise<LifecycleResult> {
  let password = "";
  try {
    const conn = boxConnection(box, deps.secretKey);
    password = conn.password;
    await run(conn);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      problem: `Could not ${action} the project: ${safeErrorMessage(error, password)}`,
    };
  }
}

function isObjectInUse(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === OBJECT_IN_USE;
}

// Superusers, such as a superuser box admin, bypass the revoked CONNECT and may reconnect between
// the terminate and the rename, which then fails as in use: terminate again and retry.
async function renameAway(client: pg.Client, project: Project, now: Date): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    await client.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [project.dbName],
    );
    const taken = await client.query<{ datname: string }>(
      "select datname from pg_database where starts_with(datname, $1)",
      [`${project.dbName}__deleted_`],
    );
    const name = deletedDbNameFor(
      project.dbName,
      now,
      taken.rows.map((row) => row.datname),
    );
    try {
      await client.query(
        `ALTER DATABASE ${pg.escapeIdentifier(project.dbName)} RENAME TO ${pg.escapeIdentifier(name)}`,
      );
      return name;
    } catch (error) {
      if (!isObjectInUse(error) || attempt >= RENAME_ATTEMPTS) throw error;
    }
  }
}

// The REVOKE commits on its own before the terminate: inside one transaction it stays invisible to
// other sessions, so the owner's apps and pools would reconnect straight away and keep the database
// in use. If the rename still fails, CONNECT is granted back so the project stays usable. The role
// keeps LOGIN on purpose (§7): a NOLOGIN role fails Supavisor's auth, and its auth-failure breakers
// would then refuse pooler logins for every project on the box.
export async function softDeleteProject(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
  now: Date = new Date(),
): Promise<LifecycleResult> {
  return holdingProject(deps.db, project, DELETE, (current) => softDelete(deps, current, box, now));
}

async function softDelete(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
  now: Date,
): Promise<LifecycleResult> {
  const db = pg.escapeIdentifier(project.dbName);
  const role = pg.escapeIdentifier(project.ownerRole);
  let deletedDbName = "";
  const result = await onBox(deps, box, "delete", (conn) =>
    deps.admin(conn, async (client) => {
      await joinOwnerRole(client, box, project.ownerRole);
      await client.query(`REVOKE CONNECT ON DATABASE ${db} FROM ${role}`);
      try {
        deletedDbName = await renameAway(client, project, now);
      } catch (error) {
        try {
          await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
        } catch (grantError) {
          const reason = grantError instanceof Error ? grantError.message : String(grantError);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; granting CONNECT back to ${project.ownerRole} also failed (${reason}), so the owner cannot connect until the project is deleted again or CONNECT is granted by hand`,
          );
        }
        throw error;
      }
    }),
  );
  if (!result.ok) return result;
  markProjectDeleted(deps.db, project.id, deletedDbName, now.toISOString());
  await deps.onLifecycle?.(box, project, "deleted");
  return result;
}

export async function restoreProject(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
): Promise<LifecycleResult> {
  return holdingProject(deps.db, project, UNDELETE, (current) => undelete(deps, current, box));
}

async function undelete(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
): Promise<LifecycleResult> {
  const { deletedDbName } = project;
  if (deletedDbName === null) return { ok: false, problem: "Project is not deleted" };
  const db = pg.escapeIdentifier(project.dbName);
  const role = pg.escapeIdentifier(project.ownerRole);
  const result = await onBox(deps, box, "restore", async (conn) => {
    await deps.onLifecycle?.(box, project, "restoring");
    await deps.admin(conn, async (client) => {
      await joinOwnerRole(client, box, project.ownerRole);
      await inTransaction(client, async () => {
        await client.query(`ALTER DATABASE ${pg.escapeIdentifier(deletedDbName)} RENAME TO ${db}`);
        await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
      });
    });
  });
  if (result.ok) markProjectRestored(deps.db, project.id);
  return result;
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
  return holdingProject(deps.db, project, PURGE, (current) => purge(deps, current, box));
}

async function purge(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
): Promise<LifecycleResult> {
  const { deletedDbName } = project;
  if (deletedDbName === null) return { ok: false, problem: "Project is not deleted" };
  const result = await onBox(deps, box, "purge", async (conn) => {
    if ((await deps.onLifecycle?.(box, project, "purging")) === "skip-sql") return;
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
      await joinOwnerRole(client, box, project.ownerRole);
      await client.query(
        `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(deletedDbName)} WITH (FORCE)`,
      );
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(project.ownerRole)}`);
    });
  });
  if (!result.ok) return result;
  deleteProject(deps.db, project.id);
  try {
    await deps.onLifecycle?.(box, project, "purged");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      problem: `Purged ${project.ref}, but cleaning up box ${box.name} failed (${reason}). Remove the box on the Boxes page to finish.`,
    };
  }
  return result;
}

// One project's failure never stops the rest. An unexpected throw is logged by class only: its
// message may carry a box credential.
export async function purgeExpiredProjects(
  deps: ProjectServiceDeps,
  purgeAfterDays: number,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - purgeAfterDays * DAY_MS).toISOString();
  for (const project of listProjectsDeletedBefore(deps.db, cutoff)) {
    const busy = busyReason(deps.db, project);
    if (busy !== undefined) {
      console.warn(`hattisar: auto-purge of ${project.ref} skipped: ${busy}; retrying next hour`);
      continue;
    }
    try {
      const box = getBoxById(deps.db, project.boxId);
      if (box === undefined) continue;
      const result = await purgeProject(deps, project, box);
      if (!result.ok) {
        console.error(`hattisar: auto-purge of ${project.ref} failed: ${result.problem}`);
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown error";
      console.error(`hattisar: auto-purge of ${project.ref} failed: ${name}`);
    }
  }
}

export function purgeDate(project: Project, purgeAfterDays: number): Date | undefined {
  if (project.deletedAt === null) return undefined;
  return new Date(Date.parse(project.deletedAt) + purgeAfterDays * DAY_MS);
}
