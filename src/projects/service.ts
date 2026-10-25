import pg from "pg";
import type { AdminClientRunner, BoxConnection } from "../boxes/admin-client.js";
import { safeErrorMessage } from "../boxes/admin-client.js";
import { boxConnection } from "../boxes/service.js";
import { type Box, getBoxById } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import {
  getProjectByRef,
  insertProject,
  type Project,
  renameProject,
  setProjectOwnerPassword,
} from "../registry/projects.js";
import { decryptSecret, encryptSecret } from "../registry/secrets.js";
import { baselineSql } from "./baseline.js";
import { holdingProject, type ProjectOperation } from "./locks.js";
import { dbNameFor, ownerRoleFor, refProblem } from "./naming.js";
import { generateOwnerPassword, scramVerifier } from "./owner-password.js";
import type { PoolerRefresher } from "./pooler.js";

const MAX_NAME_LENGTH = 100;
const INSUFFICIENT_PRIVILEGE = "42501";

export type LifecycleEvent = "deleted" | "restoring" | "purging" | "purged";

// Seam for managed boxes (§10): "restoring" and "purging" fire before the box is touched so a
// stopped box can be started first; "deleted" and "purged" fire after the box and registry have
// changed. "purging" may answer "skip-sql" when "purged" will remove the whole box, database and
// role with it, so a stopped box is not started only to drop them.
export type LifecycleHook = (
  box: Box,
  project: Project,
  event: LifecycleEvent,
) => Promise<"skip-sql" | undefined>;

export interface ProjectServiceDeps {
  db: Registry;
  secretKey: Buffer;
  admin: AdminClientRunner;
  refreshPooler: PoolerRefresher;
  poolerHost: string;
  onLifecycle?: LifecycleHook;
}

export interface ProjectForm {
  name: string;
  ref: string;
  boxId: number;
}

export type CreateResult = { ok: true; project: Project } | { ok: false; problems: string[] };

class UnavailableError extends Error {}

function nameProblem(name: string): string | undefined {
  if (name === "") return "Name is required";
  if (name.length > MAX_NAME_LENGTH) return `Name must be at most ${MAX_NAME_LENGTH} characters`;
  return undefined;
}

export function projectFieldProblems(db: Registry, form: Pick<ProjectForm, "name" | "ref">) {
  const problems = [nameProblem(form.name), refProblem(form.ref)].filter(
    (problem) => problem !== undefined,
  );
  if (problems.length === 0 && getProjectByRef(db, form.ref) !== undefined) {
    problems.push(`Ref ${form.ref} is already taken`);
  }
  return problems;
}

export function validateProjectForm(db: Registry, form: ProjectForm): { box: Box } | string[] {
  const problems = projectFieldProblems(db, form);
  const box = getBoxById(db, form.boxId);
  if (box === undefined) problems.push("Choose a box");
  return problems.length > 0 || box === undefined ? problems : { box };
}

interface Created {
  role: boolean;
  database: boolean;
}

export interface ProjectNames {
  dbName: string;
  ownerRole: string;
}

// A non-superuser admin must be a member of the owner role to create, rename or drop its database,
// drop the role or change its password. Granted again before each of those, since the owner can
// revoke it (PG15) and a box edited from a superuser admin never had it.
export async function joinOwnerRole(
  client: pg.Client,
  conn: BoxConnection,
  box: Pick<Box, "adminSuperuser">,
  ownerRole: string,
): Promise<void> {
  if (box.adminSuperuser) return;
  await client.query(
    `GRANT ${pg.escapeIdentifier(ownerRole)} TO ${pg.escapeIdentifier(conn.user)}`,
  );
}

// §7 steps 2–4, for an owner role that already exists. Also how a restore recreates a database.
export async function createProjectDatabase(
  admin: AdminClientRunner,
  conn: BoxConnection,
  box: Pick<Box, "adminSuperuser">,
  names: ProjectNames,
  onCreated: () => void = () => {},
): Promise<void> {
  const db = pg.escapeIdentifier(names.dbName);
  const role = pg.escapeIdentifier(names.ownerRole);
  await admin(conn, async (client) => {
    await joinOwnerRole(client, conn, box, names.ownerRole);
    await client.query(`CREATE DATABASE ${db} OWNER ${role}`);
    onCreated();
    await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
  });
  await admin(
    conn,
    async (client) => {
      await client.query(baselineSql(names.dbName, names.ownerRole));
      await createPgStatStatements(client);
    },
    names.dbName,
  );
}

// Only a superuser may create pg_stat_statements; without it Query Performance stays empty.
async function createPgStatStatements(client: pg.Client): Promise<void> {
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== INSUFFICIENT_PRIVILEGE) throw error;
  }
}

async function provision(
  admin: AdminClientRunner,
  conn: BoxConnection,
  box: Box,
  names: ProjectNames,
  password: string,
  created: Created,
): Promise<void> {
  await admin(conn, async (client) => {
    const existing = await client.query("select 1 from pg_database where datname = $1", [
      names.dbName,
    ]);
    if (existing.rowCount !== 0) {
      throw new UnavailableError(
        `A database named ${names.dbName} already exists on box ${box.name}`,
      );
    }
    await client.query(
      `CREATE ROLE ${pg.escapeIdentifier(names.ownerRole)} LOGIN PASSWORD ${pg.escapeLiteral(scramVerifier(password))}`,
    );
    created.role = true;
  });
  await createProjectDatabase(admin, conn, box, names, () => {
    created.database = true;
  });
}

// Drops only what this attempt created: a role that already existed belongs to someone else.
async function compensate(
  admin: AdminClientRunner,
  conn: BoxConnection,
  names: ProjectNames,
  created: Created,
): Promise<string | undefined> {
  if (!created.role && !created.database) return undefined;
  try {
    await admin(conn, async (client) => {
      // FORCE: the pooler may already hold connections to the new database.
      if (created.database) {
        await client.query(
          `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(names.dbName)} WITH (FORCE)`,
        );
      }
      if (created.role) {
        await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(names.ownerRole)}`);
      }
    });
    return undefined;
  } catch (error) {
    const message = safeErrorMessage(error, conn.password);
    console.error(`hattisar: cleanup after a failed create of ${names.dbName} failed: ${message}`);
    return `Cleanup failed (${message}): database ${names.dbName} and role ${names.ownerRole} may remain on the box`;
  }
}

export async function createProject(
  deps: ProjectServiceDeps,
  form: ProjectForm,
): Promise<CreateResult> {
  const valid = validateProjectForm(deps.db, form);
  if (Array.isArray(valid)) return { ok: false, problems: valid };
  const { box } = valid;
  const conn = boxConnection(box, deps.secretKey);
  const dbName = dbNameFor(form.ref);
  const names: ProjectNames = { dbName, ownerRole: ownerRoleFor(dbName) };
  const password = generateOwnerPassword();
  const created: Created = { role: false, database: false };

  let project: Project;
  try {
    await provision(deps.admin, conn, box, names, password, created);
    project = insertProject(deps.db, {
      ref: form.ref,
      name: form.name,
      boxId: box.id,
      ...names,
      ownerPasswordEnc: encryptSecret(password, deps.secretKey),
    });
  } catch (error) {
    const problems =
      error instanceof UnavailableError
        ? [error.message]
        : [`Could not create the project: ${safeErrorMessage(error, conn.password)}`];
    const cleanup = await compensate(deps.admin, conn, names, created);
    return { ok: false, problems: cleanup === undefined ? problems : [...problems, cleanup] };
  }
  await deps.refreshPooler(box, project, password);
  return { ok: true, project };
}

export function renameProjectDisplay(
  db: Registry,
  project: Project,
  name: string,
): { ok: true } | { ok: false; problem: string } {
  const problem = nameProblem(name);
  if (problem !== undefined) return { ok: false, problem };
  renameProject(db, project.id, name);
  return { ok: true };
}

const ROTATE: ProjectOperation = {
  action: "rotate the password of",
  holds: "its password is being rotated",
  status: "active",
};

export async function rotateOwnerPassword(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  return holdingProject(deps.db, project, ROTATE, (current) => rotate(deps, current, box));
}

async function rotate(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  const conn = boxConnection(box, deps.secretKey);
  const password = generateOwnerPassword();
  try {
    await deps.admin(conn, async (client) => {
      await joinOwnerRole(client, conn, box, project.ownerRole);
      await client.query(
        `ALTER ROLE ${pg.escapeIdentifier(project.ownerRole)} PASSWORD ${pg.escapeLiteral(scramVerifier(password))}`,
      );
    });
  } catch (error) {
    return {
      ok: false,
      problem: `Could not rotate the password: ${safeErrorMessage(error, conn.password)}`,
    };
  }
  setProjectOwnerPassword(deps.db, project.id, encryptSecret(password, deps.secretKey));
  await deps.refreshPooler(box, project, password);
  return { ok: true };
}

export function ownerPassword(project: Project, secretKey: Buffer): string {
  return decryptSecret(project.ownerPasswordEnc, secretKey);
}
