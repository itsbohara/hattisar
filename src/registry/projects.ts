import type { Registry } from "./db.js";

export type ProjectStatus = "active" | "deleted";
export type ProjectKind = "created" | "attached";

export interface NewProject {
  ref: string;
  name: string;
  boxId: number;
  dbName: string;
  ownerRole: string;
  ownerPasswordEnc: string;
  kind?: ProjectKind;
  loginSuperuser?: boolean;
}

export interface Project extends NewProject {
  kind: ProjectKind;
  loginSuperuser: boolean;
  id: number;
  status: ProjectStatus;
  deletedAt: string | null;
  deletedDbName: string | null;
  createdAt: string;
}

type ProjectRow = Omit<Project, "loginSuperuser"> & { loginSuperuser: number };

const COLUMNS = `id, ref, name, box_id AS boxId, db_name AS dbName, owner_role AS ownerRole,
  owner_password_enc AS ownerPasswordEnc, kind, login_superuser AS loginSuperuser,
  status, deleted_at AS deletedAt, deleted_db_name AS deletedDbName, created_at AS createdAt`;

function toProject({ loginSuperuser, ...row }: ProjectRow): Project {
  return { ...row, loginSuperuser: loginSuperuser === 1 };
}

export function insertProject(
  db: Registry,
  { kind = "created", loginSuperuser = false, ...project }: NewProject,
  now: string = new Date().toISOString(),
): Project {
  const row = db
    .prepare<[Record<string, unknown>], ProjectRow>(
      `INSERT INTO projects
         (ref, name, box_id, db_name, owner_role, owner_password_enc, kind, login_superuser,
          status, created_at)
       VALUES (@ref, @name, @boxId, @dbName, @ownerRole, @ownerPasswordEnc, @kind,
          @loginSuperuser, 'active', @createdAt)
       RETURNING ${COLUMNS}`,
    )
    .get({
      ...project,
      kind,
      loginSuperuser: Number(loginSuperuser),
      createdAt: now,
    }) as ProjectRow;
  return toProject(row);
}

export function getProjectById(db: Registry, id: number): Project | undefined {
  const row = db
    .prepare<[number], ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE id = ?`)
    .get(id);
  return row && toProject(row);
}

// Returns deleted projects too: a ref stays reserved until purge.
export function getProjectByRef(db: Registry, ref: string): Project | undefined {
  const row = db
    .prepare<[string], ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE ref = ?`)
    .get(ref);
  return row && toProject(row);
}

export function listProjects(db: Registry, status: ProjectStatus): Project[] {
  return db
    .prepare<[ProjectStatus], ProjectRow>(
      `SELECT ${COLUMNS} FROM projects WHERE status = ? ORDER BY name, ref`,
    )
    .all(status)
    .map(toProject);
}

export function listProjectsOnBox(db: Registry, boxId: number): Project[] {
  return db
    .prepare<[number], ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE box_id = ? ORDER BY ref`)
    .all(boxId)
    .map(toProject);
}

export function listProjectsDeletedBefore(db: Registry, cutoff: string): Project[] {
  return db
    .prepare<[string], ProjectRow>(
      `SELECT ${COLUMNS} FROM projects WHERE status = 'deleted' AND deleted_at < ? ORDER BY deleted_at`,
    )
    .all(cutoff)
    .map(toProject);
}

export function renameProject(db: Registry, id: number, name: string): void {
  db.prepare<[string, number]>("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
}

export function setProjectOwnerPassword(db: Registry, id: number, ownerPasswordEnc: string): void {
  db.prepare<[string, number]>("UPDATE projects SET owner_password_enc = ? WHERE id = ?").run(
    ownerPasswordEnc,
    id,
  );
}

export function setProjectLogin(
  db: Registry,
  id: number,
  login: string,
  passwordEnc: string,
  superuser: boolean,
): void {
  db.prepare<[string, string, number, number]>(
    "UPDATE projects SET owner_role = ?, owner_password_enc = ?, login_superuser = ? WHERE id = ?",
  ).run(login, passwordEnc, Number(superuser), id);
}

export function markProjectDeleted(
  db: Registry,
  id: number,
  deletedDbName: string,
  now: string = new Date().toISOString(),
): void {
  db.prepare<[string, string, number]>(
    "UPDATE projects SET status = 'deleted', deleted_at = ?, deleted_db_name = ? WHERE id = ?",
  ).run(now, deletedDbName, id);
}

export function markProjectRestored(db: Registry, id: number): void {
  db.prepare<[number]>(
    "UPDATE projects SET status = 'active', deleted_at = NULL, deleted_db_name = NULL WHERE id = ?",
  ).run(id);
}

// Cascades to the project's backup rows, schedule and snippets; the S3 objects are the caller's
// concern.
export function deleteProject(db: Registry, id: number): void {
  db.prepare<[number]>("DELETE FROM projects WHERE id = ?").run(id);
}
