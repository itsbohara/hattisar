import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import type { Registry } from "../registry/db.js";
import {
  countSnippets,
  createFolder,
  deleteFolders,
  deleteSnippets,
  type FolderRow,
  getSnippet,
  isValidSnippetName,
  listFolders,
  listSnippets,
  renameFolder,
  type SnippetQuery,
  type SnippetRow,
  type SnippetSummary,
  saveSnippet,
} from "../registry/snippets.js";
import type { ProjectSummary } from "./projects-source.js";

// Studio's own limit (its bodyParser sizeLimit "5mb").
const BODY_LIMIT = 5 * 1024 * 1024;
const TOO_LARGE = Symbol("too large");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBILITIES = ["user", "project", "org", "public"];

const NOT_FOUND_BODY = { message: "Not found" };
const CONTENT_NOT_FOUND_BODY = { message: "Content not found." };
const SNIPPET_IDS_REQUIRED = { error: "Snippet IDs are required" };
const FOLDER_IDS_REQUIRED = { error: "Folder IDs are required" };
const INVALID_NAME = "Names must be non-empty and contain no / or NUL";

type ListQuery = Omit<SnippetQuery, "folderId" | "includeSql"> & { visibility?: string };

export async function handleContent(
  c: Context<AuthEnv>,
  db: Registry,
  project: ProjectSummary,
  method: string,
  rest: string,
): Promise<Response> {
  const scope: Scope = { c, db, projectId: project.id, username: c.var.session.user.username };
  if (rest === "") {
    if (method === "GET") return listContent(scope);
    if (method === "PUT") return upsertSnippet(scope);
    if (method === "DELETE") return removeSnippets(scope);
  } else if (rest === "/count") {
    if (method === "GET") return count(scope);
  } else if (rest === "/folders") {
    if (method === "GET") return listFolder(scope, null);
    if (method === "POST") return addFolder(scope);
    if (method === "DELETE") return removeFolders(scope);
  } else {
    const item = /^\/item\/([^/]+)$/.exec(rest)?.[1];
    if (item !== undefined && method === "GET") return getItem(scope, item);
    const folder = /^\/folders\/([^/]+)$/.exec(rest)?.[1];
    if (folder !== undefined && method === "GET") return listFolder(scope, folder);
    if (folder !== undefined && method === "PATCH") return renameOne(scope, folder);
  }
  return c.json(NOT_FOUND_BODY, 404);
}

interface Scope {
  c: Context<AuthEnv>;
  db: Registry;
  projectId: number;
  username: string;
}

function listContent({ c, db, projectId, username }: Scope): Response {
  const query = parseListQuery(c);
  if (query === undefined) return c.json({ data: [] }, 400);
  if (query.visibility === "project") return c.json({ data: [] });
  const page = listSnippets(db, projectId, { ...query, folderId: null, includeSql: true });
  return c.json({
    data: page.items.map((row) => studioSnippetWithContent(row, username)),
    cursor: page.cursor,
  });
}

function listFolder({ c, db, projectId, username }: Scope, folderId: string | null): Response {
  const query = parseListQuery(c);
  if (query === undefined) return c.json({ data: [] }, 400);
  const page = listSnippets(db, projectId, { ...query, folderId, includeSql: false });
  const folders = folderId === null ? listFolders(db, projectId).map(studioFolder) : [];
  return c.json({
    data: { folders, contents: page.items.map((row) => studioSnippet(row, username)) },
    cursor: page.cursor,
  });
}

function parseListQuery(c: Context<AuthEnv>): ListQuery | undefined {
  const { name, cursor, limit, sort_by, sort_order, visibility } = c.req.query();
  const pageSize = limit === undefined ? 100 : Number(limit);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) return undefined;
  if (sort_by !== undefined && sort_by !== "name" && sort_by !== "inserted_at") return undefined;
  if (sort_order !== undefined && sort_order !== "asc" && sort_order !== "desc") return undefined;
  if (visibility !== undefined && visibility !== "user" && visibility !== "project") {
    return undefined;
  }
  return {
    name,
    cursor,
    limit: pageSize,
    sortBy: sort_by ?? "inserted_at",
    sortOrder: sort_order ?? "desc",
    visibility,
  };
}

function getItem({ c, db, projectId, username }: Scope, id: string): Response {
  const row = getSnippet(db, projectId, id);
  if (row === undefined) return c.json(CONTENT_NOT_FOUND_BODY, 404);
  return c.json(studioSnippetWithContent(row, username));
}

function count({ c, db, projectId }: Scope): Response {
  const name = c.req.query("name");
  const total = countSnippets(db, projectId, name);
  return name ? c.json({ count: total }) : c.json({ shared: 0, favorites: 0, private: total });
}

async function upsertSnippet({ c, db, projectId, username }: Scope): Promise<Response> {
  const body = await readJson(c.req.raw);
  if (body === TOO_LARGE) return c.json({ error: "Body exceeded 5mb limit" }, 413);
  if (!isRecord(body) || typeof body.id !== "string") {
    return c.json({ error: "A snippet needs an id" }, 400);
  }
  const existing = getSnippet(db, projectId, body.id);
  const problem = existing ? snippetProblem(body) : newSnippetProblem(body);
  if (problem) return c.json({ error: problem }, 400);

  const content = body.content as { sql: string };
  const folderId =
    body.folder_id === undefined ? (existing?.folderId ?? null) : (body.folder_id as string | null);
  const result = saveSnippet(db, projectId, {
    id: body.id,
    name: body.name as string,
    sql: content.sql,
    folderId,
  });
  if (result.ok) return c.json(studioSnippetWithContent(result.snippet, username));
  switch (result.reason) {
    case "name-taken":
      return c.json({ error: "A snippet with this name already exists in the folder" }, 409);
    case "unknown-folder":
      return c.json({ error: "Folder not found" }, 400);
    case "invalid-name":
      return c.json({ error: INVALID_NAME }, 400);
  }
}

// Studio validates only a new snippet against its full schema; an update reads just these fields.
function snippetProblem(body: Record<string, unknown>): string | undefined {
  if (typeof body.name !== "string") return "name must be a string";
  if (!isRecord(body.content) || typeof body.content.sql !== "string") {
    return "content.sql must be a string";
  }
  if (body.folder_id !== undefined && body.folder_id !== null) {
    if (typeof body.folder_id !== "string") return "folder_id must be a string or null";
  }
  return undefined;
}

function newSnippetProblem(body: Record<string, unknown>): string | undefined {
  const problem = snippetProblem(body);
  if (problem) return problem;
  const content = body.content as Record<string, unknown>;
  if (!UUID.test(body.id as string)) return "id must be a uuid";
  if (body.type !== "sql") return 'type must be "sql"';
  if (typeof content.content_id !== "string") return "content.content_id must be a string";
  if (content.schema_version !== "1.0") return 'content.schema_version must be "1.0"';
  if (typeof body.visibility !== "string" || !VISIBILITIES.includes(body.visibility)) {
    return "visibility is invalid";
  }
  return undefined;
}

function removeSnippets({ c, db, projectId }: Scope): Response {
  const ids = splitIds(c.req.query("ids"));
  if (ids.length === 0 || !ids.every((id) => UUID.test(id))) {
    return c.json(SNIPPET_IDS_REQUIRED, 400);
  }
  return c.json(deleteSnippets(db, projectId, ids).map((id) => ({ id })));
}

async function addFolder({ c, db, projectId }: Scope): Promise<Response> {
  const body = await readJson(c.req.raw);
  if (body === TOO_LARGE) return c.json({ error: "Body exceeded 5mb limit" }, 413);
  if (!isRecord(body) || typeof body.name !== "string") {
    return c.json({ error: "name must be a string" }, 400);
  }
  const result = createFolder(db, projectId, body.name);
  if (result.ok) return c.json(studioFolder(result.folder), 201);
  return result.reason === "name-taken"
    ? c.json({ error: "A folder with this name already exists" }, 409)
    : c.json({ error: INVALID_NAME }, 400);
}

function removeFolders({ c, db, projectId }: Scope): Response {
  const ids = splitIds(c.req.query("ids")).filter(Boolean);
  if (ids.length === 0) return c.json(FOLDER_IDS_REQUIRED, 400);
  deleteFolders(db, projectId, ids);
  return c.json({});
}

async function renameOne({ c, db, projectId }: Scope, id: string): Promise<Response> {
  const body = await readJson(c.req.raw);
  if (body === TOO_LARGE) return c.json({ error: "Body exceeded 5mb limit" }, 413);
  if (!isRecord(body) || typeof body.name !== "string") {
    return c.json({ error: "name must be a string" }, 400);
  }
  if (!isValidSnippetName(body.name)) return c.json({ error: INVALID_NAME }, 400);
  if (renameFolder(db, projectId, id, body.name)) return c.json({});
  return listFolders(db, projectId).some((folder) => folder.id === id)
    ? c.json({ error: "A folder with this name already exists" }, 409)
    : c.json({ error: "Folder not found" }, 404);
}

function splitIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(",").map((id) => id.trim()))];
}

async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > BODY_LIMIT) return TOO_LARGE;
  const reader = request.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(chunk.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function studioSnippet(row: SnippetSummary, username: string) {
  const user = { id: 1, username };
  return {
    id: row.id,
    inserted_at: row.insertedAt,
    updated_at: row.updatedAt,
    type: "sql",
    name: row.name,
    description: "",
    favorite: false,
    visibility: "user",
    project_id: 1,
    folder_id: row.folderId,
    owner_id: 1,
    owner: user,
    updated_by: user,
  };
}

// content_id is fresh on every response, as Studio's own is.
function studioSnippetWithContent(row: SnippetRow, username: string) {
  return {
    ...studioSnippet(row, username),
    content: { sql: row.sql, content_id: randomUUID(), schema_version: "1.0" },
  };
}

function studioFolder(folder: FolderRow) {
  return { id: folder.id, name: folder.name, owner_id: 1, parent_id: null, project_id: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
