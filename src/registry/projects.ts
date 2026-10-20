import type { Registry } from "./db.js";

export type ProjectStatus = "active" | "deleted";

export interface NewProject {
  ref: string;
  name: string;
  boxId: number;
  dbName: string;
  ownerRole: string;
  ownerPasswordEnc: string;
}

export interface Project extends NewProject {
  id: number;
  status: ProjectStatus;
  deletedAt: string | null;
  deletedDbName: string | null;
  createdAt: string;
}

const COLUMNS = `id, ref, name, box_id AS boxId, db_name AS dbName, owner_role AS ownerRole,
  owner_password_enc AS ownerPasswordEnc, status, deleted_at AS deletedAt,
  deleted_db_name AS deletedDbName, created_at AS createdAt`;

export function insertProject(
  db: Registry,
  project: NewProject,
  now: string = new Date().toISOString(),
): Project {
  return db
    .prepare<[NewProject & { createdAt: string }], Project>(
      `INSERT INTO projects
         (ref, name, box_id, db_name, owner_role, owner_password_enc, status, created_at)
       VALUES (@ref, @name, @boxId, @dbName, @ownerRole, @ownerPasswordEnc, 'active', @createdAt)
       RETURNING ${COLUMNS}`,
    )
    .get({ ...project, createdAt: now }) as Project;
}

export function getProjectById(db: Registry, id: number): Project | undefined {
  return db.prepare<[number], Project>(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id);
}

// Returns deleted projects too: a ref stays reserved until purge.
export function getProjectByRef(db: Registry, ref: string): Project | undefined {
  return db.prepare<[string], Project>(`SELECT ${COLUMNS} FROM projects WHERE ref = ?`).get(ref);
}

export function listProjects(db: Registry, status: ProjectStatus): Project[] {
  return db
    .prepare<[ProjectStatus], Project>(
      `SELECT ${COLUMNS} FROM projects WHERE status = ? ORDER BY name, ref`,
    )
    .all(status);
}

export function listProjectsOnBox(db: Registry, boxId: number): Project[] {
  return db
    .prepare<[number], Project>(`SELECT ${COLUMNS} FROM projects WHERE box_id = ? ORDER BY ref`)
    .all(boxId);
}

export function listProjectsDeletedBefore(db: Registry, cutoff: string): Project[] {
  return db
    .prepare<[string], Project>(
      `SELECT ${COLUMNS} FROM projects WHERE status = 'deleted' AND deleted_at < ? ORDER BY deleted_at`,
    )
    .all(cutoff);
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

// Cascades to the project's backup rows and schedule; the S3 objects are the caller's concern.
export function deleteProject(db: Registry, id: number): void {
  db.prepare<[number]>("DELETE FROM projects WHERE id = ?").run(id);
}
