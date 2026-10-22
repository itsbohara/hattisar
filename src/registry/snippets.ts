import { folderId, snippetId } from "../snippets/ids.js";
import type { Registry } from "./db.js";

export interface SnippetRow {
  id: string;
  folderId: string | null;
  name: string;
  sql: string;
  insertedAt: string;
  updatedAt: string;
}

export type SnippetSummary = Omit<SnippetRow, "sql">;

export interface FolderRow {
  id: string;
  name: string;
  createdAt: string;
}

export interface SnippetQuery {
  name?: string;
  folderId?: string | null;
  limit: number;
  cursor?: string;
  sortBy: "name" | "inserted_at";
  sortOrder: "asc" | "desc";
  includeSql: boolean;
}

export interface SnippetPage<T> {
  items: T[];
  cursor?: string;
}

export type SaveResult =
  | { ok: true; snippet: SnippetRow }
  | { ok: false; reason: "name-taken" | "unknown-folder" | "invalid-name" };

export type CreateFolderResult =
  | { ok: true; folder: FolderRow }
  | { ok: false; reason: "name-taken" | "invalid-name" };

const SUMMARY_COLUMNS =
  "id, folder_id AS folderId, name, inserted_at AS insertedAt, updated_at AS updatedAt";
const COLUMNS = `${SUMMARY_COLUMNS}, sql`;
const FOLDER_COLUMNS = "id, name, created_at AS createdAt";

export function isValidSnippetName(name: string): boolean {
  return name !== "" && !name.includes("/") && !name.includes("\0");
}

// Filtering, sorting and paging mirror Studio's in-memory getSnippets, including its Unicode
// toLowerCase matching, which SQLite's ASCII-only LIKE and lower() cannot reproduce.
export function listSnippets(
  db: Registry,
  projectId: number,
  q: SnippetQuery & { includeSql: true },
): SnippetPage<SnippetRow>;
export function listSnippets(
  db: Registry,
  projectId: number,
  q: SnippetQuery,
): SnippetPage<SnippetSummary>;
export function listSnippets(
  db: Registry,
  projectId: number,
  q: SnippetQuery,
): SnippetPage<SnippetSummary> {
  const columns = q.includeSql ? COLUMNS : SUMMARY_COLUMNS;
  const term = q.name?.trim().toLowerCase();
  const rows = term
    ? selectSnippets(db, projectId, columns).filter((row) => row.name.toLowerCase().includes(term))
    : db
        .prepare<[number, string | null], SnippetSummary>(
          `SELECT ${columns} FROM snippets WHERE project_id = ? AND folder_id IS ? ORDER BY id`,
        )
        .all(projectId, q.folderId ?? null);

  const sortKey = (row: SnippetSummary) =>
    q.sortBy === "name" ? row.name.toLowerCase() : row.insertedAt;
  rows.sort((a, b) => compare(sortKey(a), sortKey(b)));
  if (q.sortOrder === "desc") rows.reverse();

  const after = q.cursor === undefined ? -1 : rows.findIndex((row) => row.id === q.cursor);
  const rest = rows.slice(after + 1);
  if (rest.length <= q.limit) return { items: rest };
  const items = rest.slice(0, q.limit);
  return { items, cursor: items.at(-1)?.id };
}

function selectSnippets(db: Registry, projectId: number, columns: string): SnippetSummary[] {
  return db
    .prepare<[number], SnippetSummary>(
      `SELECT ${columns} FROM snippets WHERE project_id = ? ORDER BY id`,
    )
    .all(projectId);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function getSnippet(db: Registry, projectId: number, id: string): SnippetRow | undefined {
  return db
    .prepare<[number, string], SnippetRow>(
      `SELECT ${COLUMNS} FROM snippets WHERE project_id = ? AND id = ?`,
    )
    .get(projectId, id);
}

export function countSnippets(db: Registry, projectId: number, name?: string): number {
  const term = name?.trim().toLowerCase();
  const rows = selectSnippets(db, projectId, SUMMARY_COLUMNS);
  return term ? rows.filter((row) => row.name.toLowerCase().includes(term)).length : rows.length;
}

// Upsert by id. Studio's browser recomputes the id from folder and name before it reloads a
// renamed or moved snippet, so the stored id must follow the same rule.
export function saveSnippet(
  db: Registry,
  projectId: number,
  input: { id: string; name: string; sql: string; folderId: string | null },
  now: string = new Date().toISOString(),
): SaveResult {
  if (!isValidSnippetName(input.name)) return { ok: false, reason: "invalid-name" };
  if (input.folderId !== null && !getFolder(db, projectId, input.folderId)) {
    return { ok: false, reason: "unknown-folder" };
  }
  const existing = getSnippet(db, projectId, input.id);
  try {
    const snippet = existing
      ? updateSnippet(db, projectId, existing, input, now)
      : insertSnippet(db, projectId, input, now);
    return { ok: true, snippet };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "name-taken" };
    throw error;
  }
}

function insertSnippet(
  db: Registry,
  projectId: number,
  input: { id: string; name: string; sql: string; folderId: string | null },
  now: string,
): SnippetRow {
  return db
    .prepare<[number, string, string | null, string, string, string, string], SnippetRow>(
      `INSERT INTO snippets (project_id, id, folder_id, name, sql, inserted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    )
    .get(projectId, input.id, input.folderId, input.name, input.sql, now, now) as SnippetRow;
}

function updateSnippet(
  db: Registry,
  projectId: number,
  existing: SnippetRow,
  input: { name: string; sql: string; folderId: string | null },
  now: string,
): SnippetRow {
  const moved = existing.name !== input.name || existing.folderId !== input.folderId;
  const id = moved ? snippetId(input.folderId, input.name) : existing.id;
  return db
    .prepare<[string, string | null, string, string, string, number, string], SnippetRow>(
      `UPDATE snippets SET id = ?, folder_id = ?, name = ?, sql = ?, updated_at = ?
       WHERE project_id = ? AND id = ? RETURNING ${COLUMNS}`,
    )
    .get(id, input.folderId, input.name, input.sql, now, projectId, existing.id) as SnippetRow;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

export function deleteSnippets(db: Registry, projectId: number, ids: string[]): string[] {
  const remove = db.prepare<[number, string], { id: string }>(
    "DELETE FROM snippets WHERE project_id = ? AND id = ? RETURNING id",
  );
  return db.transaction(() =>
    ids.flatMap((id) => remove.all(projectId, id).map((row) => row.id)),
  )();
}

export function listFolders(db: Registry, projectId: number): FolderRow[] {
  return db
    .prepare<[number], FolderRow>(
      `SELECT ${FOLDER_COLUMNS} FROM snippet_folders WHERE project_id = ? ORDER BY name`,
    )
    .all(projectId);
}

function getFolder(db: Registry, projectId: number, id: string): FolderRow | undefined {
  return db
    .prepare<[number, string], FolderRow>(
      `SELECT ${FOLDER_COLUMNS} FROM snippet_folders WHERE project_id = ? AND id = ?`,
    )
    .get(projectId, id);
}

export function createFolder(
  db: Registry,
  projectId: number,
  name: string,
  now: string = new Date().toISOString(),
): CreateFolderResult {
  if (!isValidSnippetName(name)) return { ok: false, reason: "invalid-name" };
  try {
    const folder = db
      .prepare<[number, string, string, string], FolderRow>(
        `INSERT INTO snippet_folders (project_id, id, name, created_at)
         VALUES (?, ?, ?, ?) RETURNING ${FOLDER_COLUMNS}`,
      )
      .get(projectId, folderId(name), name, now) as FolderRow;
    return { ok: true, folder };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "name-taken" };
    throw error;
  }
}

// Keeps the id: Studio never renames folders, so no id the browser holds depends on the name.
// False when the folder is missing or the name is invalid or taken.
export function renameFolder(db: Registry, projectId: number, id: string, name: string): boolean {
  if (!isValidSnippetName(name)) return false;
  try {
    return (
      db
        .prepare<[string, number, string]>(
          "UPDATE snippet_folders SET name = ? WHERE project_id = ? AND id = ?",
        )
        .run(name, projectId, id).changes > 0
    );
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

// Cascades to the folders' snippets.
export function deleteFolders(db: Registry, projectId: number, ids: string[]): void {
  const remove = db.prepare<[number, string]>(
    "DELETE FROM snippet_folders WHERE project_id = ? AND id = ?",
  );
  db.transaction(() => {
    for (const id of ids) remove.run(projectId, id);
  })();
}
