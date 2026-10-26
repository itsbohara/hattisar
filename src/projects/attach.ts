import { type BoxConnection, safeErrorMessage } from "../boxes/admin-client.js";
import { boxConnection } from "../boxes/service.js";
import { type Box, getBoxById } from "../registry/boxes.js";
import {
  deleteProject,
  insertProject,
  listProjectsOnBox,
  type Project,
  setProjectLogin,
} from "../registry/projects.js";
import { decryptSecret, encryptSecret } from "../registry/secrets.js";
import { holdingProject, type ProjectOperation } from "./locks.js";
import { type CreateResult, type ProjectServiceDeps, projectFieldProblems } from "./service.js";

export interface AttachForm {
  name: string;
  ref: string;
  boxId: number;
  database: string;
  login: string;
  password: string;
}

type Outcome = { ok: true } | { ok: false; problem: string };

const UPDATE_LOGIN: ProjectOperation = {
  action: "update the login of",
  holds: "its login is being updated",
  status: "active",
};

const DETACH: ProjectOperation = {
  action: "detach",
  holds: "it is being detached",
  status: "active",
};

const ATTACHABLE_DATABASES_SQL = `select datname from pg_database
  where not datistemplate and datname <> '_supabase' and datname !~ '__deleted_\\d{8}(_\\d+)?$'
    and datname !~ '[/?#%]'
  order by datname`;

const LOGIN_CHECK_SQL = "select rolsuper from pg_roles where rolname = current_user";

export function attachedProblem(ref: string): string {
  return `${ref} is attached; detach it instead.`;
}

export function isAttached(project: Pick<Project, "kind">): boolean {
  return project.kind === "attached";
}

export function attachedConnection(project: Project, box: Box, secretKey: Buffer): BoxConnection {
  return {
    host: box.host,
    port: box.port,
    user: project.ownerRole,
    password: decryptSecret(project.ownerPasswordEnc, secretKey),
    sslmode: box.sslmode as BoxConnection["sslmode"],
  };
}

export async function attachableDatabases(
  deps: Pick<ProjectServiceDeps, "db" | "secretKey" | "admin">,
  box: Box,
): Promise<{ ok: true; databases: string[] } | { ok: false; problem: string }> {
  if (box.kind !== "registered") {
    return {
      ok: false,
      problem: `Only registered boxes can attach databases; ${box.name} is ${box.kind}.`,
    };
  }
  let names: string[];
  let password = "";
  try {
    const conn = boxConnection(box, deps.secretKey);
    password = conn.password;
    names = await deps.admin(conn, async (client) => {
      const result = await client.query<{ datname: string }>(ATTACHABLE_DATABASES_SQL);
      return result.rows.map((row) => row.datname);
    });
  } catch (error) {
    return {
      ok: false,
      problem: `Could not list the databases of box ${box.name}: ${safeErrorMessage(error, password)}`,
    };
  }
  const taken = new Set(
    listProjectsOnBox(deps.db, box.id).flatMap((project) => [
      project.dbName,
      project.deletedDbName,
    ]),
  );
  return { ok: true, databases: names.filter((name) => !taken.has(name)) };
}

// Connects as the login itself, never the box admin, so a wrong password or a login that cannot
// reach the database is caught before anything is stored.
async function readLoginSuperuser(
  deps: Pick<ProjectServiceDeps, "admin">,
  box: Box,
  database: string,
  login: string,
  password: string,
): Promise<{ ok: true; superuser: boolean } | { ok: false; problem: string }> {
  const conn: BoxConnection = {
    host: box.host,
    port: box.port,
    user: login,
    password,
    sslmode: box.sslmode as BoxConnection["sslmode"],
  };
  try {
    const superuser = await deps.admin(
      conn,
      async (client) => {
        const result = await client.query<{ rolsuper: boolean }>(LOGIN_CHECK_SQL);
        return result.rows[0]?.rolsuper === true;
      },
      database,
    );
    return { ok: true, superuser };
  } catch (error) {
    return {
      ok: false,
      problem: `Could not log in to ${database} as ${login}: ${safeErrorMessage(error, password)}`,
    };
  }
}

export function credentialProblems(login: string, password: string): string[] {
  const problems: string[] = [];
  if (login === "") problems.push("Login is required");
  if (password === "") problems.push("Password is required");
  return problems;
}

export async function attachProject(
  deps: ProjectServiceDeps,
  form: AttachForm,
): Promise<CreateResult> {
  const problems = projectFieldProblems(deps.db, form);
  const box = getBoxById(deps.db, form.boxId);
  if (box === undefined) problems.push("Choose a box");
  else if (box.kind !== "registered") {
    problems.push(`Only registered boxes can attach databases; ${box.name} is ${box.kind}.`);
  }
  problems.push(...credentialProblems(form.login, form.password));
  if (problems.length > 0 || box === undefined) return { ok: false, problems };

  const attachable = await attachableDatabases(deps, box);
  if (!attachable.ok) return { ok: false, problems: [attachable.problem] };
  if (!attachable.databases.includes(form.database)) {
    return {
      ok: false,
      problems: [`Database ${form.database} cannot be attached on box ${box.name}`],
    };
  }
  const login = await readLoginSuperuser(deps, box, form.database, form.login, form.password);
  if (!login.ok) return { ok: false, problems: [login.problem] };

  const project = insertProject(deps.db, {
    ref: form.ref,
    name: form.name,
    boxId: box.id,
    dbName: form.database,
    ownerRole: form.login,
    ownerPasswordEnc: encryptSecret(form.password, deps.secretKey),
    kind: "attached",
    loginSuperuser: login.superuser,
  });
  return { ok: true, project };
}

export async function updateProjectLogin(
  deps: ProjectServiceDeps,
  project: Project,
  box: Box,
  login: string,
  password: string,
): Promise<Outcome> {
  if (!isAttached(project)) {
    return {
      ok: false,
      problem: `${project.ref} was created by hattisar; rotate its password instead.`,
    };
  }
  return holdingProject(deps.db, project, UPDATE_LOGIN, async (current) => {
    const problems = credentialProblems(login, password);
    if (problems.length > 0) return { ok: false, problem: problems.join(", ") };
    const checked = await readLoginSuperuser(deps, box, current.dbName, login, password);
    if (!checked.ok) return checked;
    setProjectLogin(
      deps.db,
      current.id,
      login,
      encryptSecret(password, deps.secretKey),
      checked.superuser,
    );
    return { ok: true };
  });
}

export async function detachProject(deps: ProjectServiceDeps, project: Project): Promise<Outcome> {
  if (!isAttached(project)) {
    return { ok: false, problem: `${project.ref} was created by hattisar; delete it instead.` };
  }
  return holdingProject(deps.db, project, DETACH, async (current) => {
    deleteProject(deps.db, current.id);
    return { ok: true };
  });
}
