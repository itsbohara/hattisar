import { type Dirent, existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "../registry/db.js";
import { listProjects } from "../registry/projects.js";
import { getSetting, setSetting } from "../registry/settings.js";
import {
  createFolder,
  getSnippet,
  isValidSnippetName,
  listFolders,
  saveSnippet,
} from "../registry/snippets.js";
import { snippetId } from "./ids.js";

const IMPORTED_SETTING = "snippets_imported";
const SQL_SUFFIX = ".sql";

interface StudioSnippet {
  name: string;
  sql: string;
  createdAt: string;
}

interface StudioFolder {
  name: string;
  createdAt: string;
  snippets: StudioSnippet[];
}

export interface ImportCounts {
  // False when the directory does not exist, e.g. a compose file without the read-only mount.
  found: boolean;
  projects: number;
  snippets: number;
  folders: number;
}

// Studio's layout: <dir>/<name>.sql at the root, <dir>/<folder>/<name>.sql one level down.
// Studio itself ignores deeper directories and non-.sql files, so they are not snippets.
export function importStudioSnippets(db: Registry, dir: string): ImportCounts | undefined {
  if (getSetting(db, IMPORTED_SETTING) !== undefined) return undefined;
  const found = existsSync(dir);
  const entries = readEntries(dir);
  const root = readSnippets(dir, entries);
  const folders = entries
    .filter((entry) => entry.isDirectory() && isValidSnippetName(entry.name))
    .map((entry) => readFolder(join(dir, entry.name), entry.name));
  const projects = listProjects(db, "active");

  db.transaction(() => {
    for (const project of projects) {
      importInto(db, project.id, null, root);
      for (const folder of folders) {
        const id = ensureFolder(db, project.id, folder);
        if (id !== undefined) importInto(db, project.id, id, folder.snippets);
      }
    }
    setSetting(db, IMPORTED_SETTING, new Date().toISOString());
  })();

  return {
    found,
    projects: projects.length,
    snippets: root.length + folders.reduce((sum, folder) => sum + folder.snippets.length, 0),
    folders: folders.length,
  };
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function readFolder(path: string, name: string): StudioFolder {
  return {
    name,
    createdAt: createdAt(statSync(path)),
    snippets: readSnippets(path, readdirSync(path, { withFileTypes: true })),
  };
}

function readSnippets(dir: string, entries: Dirent[]): StudioSnippet[] {
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SQL_SUFFIX))
    .map((entry) => ({ entry, name: entry.name.slice(0, -SQL_SUFFIX.length) }))
    .filter(({ name }) => isValidSnippetName(name))
    .map(({ entry, name }) => {
      const path = join(dir, entry.name);
      return { name, sql: readFileSync(path, "utf8"), createdAt: createdAt(statSync(path)) };
    });
}

// Studio dates a snippet by its file's birthtime; filesystems without one report the epoch.
function createdAt(stats: Stats): string {
  return (stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime).toISOString();
}

function ensureFolder(db: Registry, projectId: number, folder: StudioFolder): string | undefined {
  const created = createFolder(db, projectId, folder.name, folder.createdAt);
  if (created.ok) return created.folder.id;
  return listFolders(db, projectId).find((existing) => existing.name === folder.name)?.id;
}

// saveSnippet upserts by id, so an existing snippet with the same id is left alone, not overwritten.
function importInto(
  db: Registry,
  projectId: number,
  folderId: string | null,
  snippets: StudioSnippet[],
): void {
  for (const snippet of snippets) {
    const id = snippetId(folderId, snippet.name);
    if (getSnippet(db, projectId, id)) continue;
    saveSnippet(
      db,
      projectId,
      { id, name: snippet.name, sql: snippet.sql, folderId },
      snippet.createdAt,
    );
  }
}
