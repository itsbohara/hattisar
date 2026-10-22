import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { deleteProject, insertProject } from "../../src/registry/projects.js";
import {
  countSnippets,
  createFolder,
  deleteFolders,
  deleteSnippets,
  getSnippet,
  listFolders,
  listSnippets,
  renameFolder,
  type SnippetRow,
  saveSnippet,
} from "../../src/registry/snippets.js";
import { folderId, snippetId } from "../../src/snippets/ids.js";

let dataDir: string;
let db: Registry;
let projectA: number;
let projectB: number;
let clock: number;

function tick(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

beforeEach(() => {
  clock = Date.parse("2026-10-20T00:00:00.000Z");
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-snippets-"));
  db = openRegistry(dataDir);
  const box = insertBox(db, {
    name: "shared",
    kind: "shared",
    devOnly: true,
    host: "db",
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: "v1:iv:tag:ct",
    sslmode: "disable",
    publicHost: "localhost",
    publicPort: 5432,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
  });
  projectA = addProject(box.id, "alpha");
  projectB = addProject(box.id, "beta");
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function addProject(boxId: number, ref: string): number {
  return insertProject(db, {
    ref,
    name: ref,
    boxId,
    dbName: ref,
    ownerRole: `hs_${ref}_owner`,
    ownerPasswordEnc: "v1:iv:tag:pw",
  }).id;
}

function save(projectId: number, name: string, folder: string | null = null, sql = "select 1") {
  const result = saveSnippet(
    db,
    projectId,
    { id: snippetId(folder, name), name, sql, folderId: folder },
    tick(),
  );
  if (!result.ok) throw new Error(result.reason);
  return result.snippet;
}

function folder(projectId: number, name: string) {
  const result = createFolder(db, projectId, name, tick());
  if (!result.ok) throw new Error(result.reason);
  return result.folder;
}

const LIST = {
  limit: 100,
  sortBy: "name",
  sortOrder: "asc",
  includeSql: true,
} as const;

function names(rows: SnippetRow[]): string[] {
  return rows.map((row) => row.name);
}

describe("snippets per project", () => {
  it("keeps the same name in two projects apart under the same id", () => {
    const a = save(projectA, "q", null, "select 'a'");
    const b = save(projectB, "q", null, "select 'b'");

    expect(a.id).toBe(b.id);
    expect(getSnippet(db, projectA, a.id)?.sql).toBe("select 'a'");
    expect(getSnippet(db, projectB, b.id)?.sql).toBe("select 'b'");
    expect(listSnippets(db, projectA, LIST).items).toEqual([a]);
    expect(listSnippets(db, projectB, LIST).items).toEqual([b]);
  });

  it("returns a saved snippet with its fields", () => {
    const snippet = save(projectA, "q", null, "select 42");
    expect(snippet).toEqual({
      id: snippetId(null, "q"),
      folderId: null,
      name: "q",
      sql: "select 42",
      insertedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(new Date(snippet.insertedAt).toISOString()).toBe(snippet.insertedAt);
    expect(getSnippet(db, projectA, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
});

describe("listSnippets", () => {
  it("lists root snippets only without a name, and one folder's with folderId", () => {
    const reports = folder(projectA, "reports");
    save(projectA, "root one");
    save(projectA, "nested", reports.id);

    expect(names(listSnippets(db, projectA, LIST).items)).toEqual(["root one"]);
    expect(names(listSnippets(db, projectA, { ...LIST, folderId: reports.id }).items)).toEqual([
      "nested",
    ]);
  });

  it("searches every folder case-insensitively by name", () => {
    const reports = folder(projectA, "reports");
    save(projectA, "Daily totals");
    save(projectA, "daily users", reports.id);
    save(projectA, "weekly");

    expect(names(listSnippets(db, projectA, { ...LIST, name: "DAILY" }).items)).toEqual([
      "Daily totals",
      "daily users",
    ]);
    expect(countSnippets(db, projectA, "daily")).toBe(2);
    expect(countSnippets(db, projectA)).toBe(3);
    expect(countSnippets(db, projectB)).toBe(0);
  });

  it("matches non-ASCII names case-insensitively and trims the search term", () => {
    save(projectA, "Ünïcödé report");
    save(projectA, "100% done");

    expect(names(listSnippets(db, projectA, { ...LIST, name: " üNÏ " }).items)).toEqual([
      "Ünïcödé report",
    ]);
    expect(names(listSnippets(db, projectA, { ...LIST, name: "%" }).items)).toEqual(["100% done"]);
  });

  it("sorts by name or inserted_at in either order", () => {
    for (const name of ["b", "c", "a"]) {
      save(projectA, name);
    }
    const byName = (sortOrder: "asc" | "desc") =>
      names(listSnippets(db, projectA, { ...LIST, sortBy: "name", sortOrder }).items);
    const byInserted = (sortOrder: "asc" | "desc") =>
      names(listSnippets(db, projectA, { ...LIST, sortBy: "inserted_at", sortOrder }).items);

    expect(byName("asc")).toEqual(["a", "b", "c"]);
    expect(byName("desc")).toEqual(["c", "b", "a"]);
    expect(byInserted("asc")).toEqual(["b", "c", "a"]);
    expect(byInserted("desc")).toEqual(["a", "c", "b"]);
  });

  it("omits sql unless asked", () => {
    save(projectA, "q");
    const [row] = listSnippets(db, projectA, { ...LIST, includeSql: false }).items;
    expect(row).not.toHaveProperty("sql");
  });

  it.each([
    ["name", "asc"],
    ["name", "desc"],
    ["inserted_at", "asc"],
    ["inserted_at", "desc"],
  ] as const)("pages by %s %s covering every row exactly once", (sortBy, sortOrder) => {
    const all = Array.from({ length: 7 }, (_, i) => save(projectA, `q${i % 3}-${i}`).id);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listSnippets(db, projectA, { ...LIST, sortBy, sortOrder, limit: 3, cursor });
      seen.push(...page.items.map((row) => row.id));
      cursor = page.cursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...all].sort());
    expect(new Set(seen).size).toBe(all.length);
  });

  it("returns no cursor when the page holds the last row", () => {
    save(projectA, "a");
    save(projectA, "b");
    expect(listSnippets(db, projectA, { ...LIST, limit: 2 }).cursor).toBeUndefined();
    expect(listSnippets(db, projectA, { ...LIST, limit: 1 }).cursor).toBe(snippetId(null, "a"));
  });
});

describe("saveSnippet", () => {
  it("updates sql in place, keeping insertedAt", () => {
    const first = save(projectA, "q", null, "select 1");
    const second = save(projectA, "q", null, "select 2");

    expect(second.id).toBe(first.id);
    expect(second.insertedAt).toBe(first.insertedAt);
    expect(second.updatedAt > first.updatedAt).toBe(true);
    expect(second.sql).toBe("select 2");
    expect(countSnippets(db, projectA)).toBe(1);
  });

  it("re-keys a renamed or moved snippet and keeps insertedAt", () => {
    const reports = folder(projectA, "reports");
    const original = save(projectA, "old");

    const renamed = saveSnippet(db, projectA, {
      id: original.id,
      name: "new",
      sql: "select 2",
      folderId: reports.id,
    });

    expect(renamed).toEqual({
      ok: true,
      snippet: expect.objectContaining({
        id: snippetId(reports.id, "new"),
        name: "new",
        folderId: reports.id,
        sql: "select 2",
        insertedAt: original.insertedAt,
      }),
    });
    expect(getSnippet(db, projectA, original.id)).toBeUndefined();
    expect(countSnippets(db, projectA)).toBe(1);
  });

  it("rejects a name already used in the same folder, root included", () => {
    const reports = folder(projectA, "reports");
    const rootQ = save(projectA, "q");
    const other = save(projectA, "other");
    const nestedQ = save(projectA, "q", reports.id);
    const nestedOther = save(projectA, "other", reports.id);

    expect(saveSnippet(db, projectA, { id: other.id, name: "q", sql: "", folderId: null })).toEqual(
      { ok: false, reason: "name-taken" },
    );
    expect(
      saveSnippet(db, projectA, { id: nestedOther.id, name: "q", sql: "", folderId: reports.id }),
    ).toEqual({ ok: false, reason: "name-taken" });
    expect(
      saveSnippet(db, projectA, { id: rootQ.id, name: "q", sql: "", folderId: reports.id }),
    ).toEqual({ ok: false, reason: "name-taken" });
    expect(getSnippet(db, projectA, nestedQ.id)).toEqual(nestedQ);
  });

  it("rejects a root name clash even under a foreign id", () => {
    save(projectA, "q");
    expect(
      saveSnippet(db, projectA, {
        id: "00000000-0000-4000-8000-000000000000",
        name: "q",
        sql: "",
        folderId: null,
      }),
    ).toEqual({ ok: false, reason: "name-taken" });
  });

  it("rejects an unknown folder, including another project's", () => {
    const foreign = folder(projectB, "reports");
    for (const folderIdValue of [folderId("nope"), foreign.id]) {
      expect(
        saveSnippet(db, projectA, {
          id: snippetId(folderIdValue, "q"),
          name: "q",
          sql: "",
          folderId: folderIdValue,
        }),
      ).toEqual({ ok: false, reason: "unknown-folder" });
    }
  });

  it.each(["", "a/b", "a\0"])("rejects the name %j", (name) => {
    expect(
      saveSnippet(db, projectA, { id: snippetId(null, name), name, sql: "", folderId: null }),
    ).toEqual({ ok: false, reason: "invalid-name" });
  });
});

describe("deleteSnippets", () => {
  it("deletes only this project's matching ids and reports them", () => {
    const a = save(projectA, "q");
    const keep = save(projectA, "keep");
    save(projectB, "q");

    expect(deleteSnippets(db, projectA, [a.id, "00000000-0000-4000-8000-000000000000"])).toEqual([
      a.id,
    ]);
    expect(names(listSnippets(db, projectA, LIST).items)).toEqual([keep.name]);
    expect(countSnippets(db, projectB)).toBe(1);
  });
});

describe("folders", () => {
  it("creates folders with Studio ids and lists them per project", () => {
    const reports = folder(projectA, "reports");
    expect(reports).toEqual({
      id: folderId("reports"),
      name: "reports",
      createdAt: expect.any(String),
    });
    expect(listFolders(db, projectA)).toEqual([reports]);
    expect(listFolders(db, projectB)).toEqual([]);
    expect(folder(projectB, "reports").id).toBe(reports.id);
  });

  it("rejects a duplicate or invalid folder name", () => {
    folder(projectA, "reports");
    expect(createFolder(db, projectA, "reports")).toEqual({ ok: false, reason: "name-taken" });
    for (const name of ["", "a/b", "a\0"]) {
      expect(createFolder(db, projectA, name)).toEqual({ ok: false, reason: "invalid-name" });
    }
  });

  it("deletes folders with their snippets", () => {
    const reports = folder(projectA, "reports");
    const nested = save(projectA, "nested", reports.id);
    const root = save(projectA, "root");
    const foreign = folder(projectB, "reports");
    save(projectB, "nested", foreign.id);

    deleteFolders(db, projectA, [reports.id]);

    expect(listFolders(db, projectA)).toEqual([]);
    expect(getSnippet(db, projectA, nested.id)).toBeUndefined();
    expect(getSnippet(db, projectA, root.id)).toEqual(root);
    expect(countSnippets(db, projectB)).toBe(1);
  });

  it("renames a folder without changing its id or its snippets' ids", () => {
    const reports = folder(projectA, "reports");
    const nested = save(projectA, "nested", reports.id);

    expect(renameFolder(db, projectA, reports.id, "archive")).toBe(true);
    expect(listFolders(db, projectA)).toEqual([{ ...reports, name: "archive" }]);
    expect(getSnippet(db, projectA, nested.id)).toEqual(nested);
    expect(renameFolder(db, projectA, folderId("nope"), "x")).toBe(false);
    expect(renameFolder(db, projectB, reports.id, "x")).toBe(false);
  });

  it("refuses to rename a folder to an invalid or taken name", () => {
    const reports = folder(projectA, "reports");
    folder(projectA, "archive");

    for (const name of ["", "a/b", "a\0", "archive"]) {
      expect(renameFolder(db, projectA, reports.id, name)).toBe(false);
    }
    expect(listFolders(db, projectA).map((row) => row.name)).toEqual(["archive", "reports"]);
  });
});

describe("project deletion", () => {
  it("removes the project's snippets and folders", () => {
    const reports = folder(projectA, "reports");
    save(projectA, "nested", reports.id);
    save(projectA, "root");
    save(projectB, "root");

    deleteProject(db, projectA);

    const count = (table: string, projectId: number) =>
      db
        .prepare<[number], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`)
        .get(projectId)?.n;
    expect(count("snippets", projectA)).toBe(0);
    expect(count("snippet_folders", projectA)).toBe(0);
    expect(count("snippets", projectB)).toBe(1);
  });
});
