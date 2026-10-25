import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject, markProjectDeleted } from "../../src/registry/projects.js";
import { getSetting } from "../../src/registry/settings.js";
import { getSnippet, listFolders, listSnippets } from "../../src/registry/snippets.js";
import { folderId, snippetId } from "../../src/snippets/ids.js";
import { importStudioSnippets } from "../../src/snippets/import.js";

const DAILY_SQL = "select now(); -- héllo ✓\n";

let dataDir: string;
let snippetsDir: string;
let db: Registry;
let boxId: number;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-import-"));
  snippetsDir = join(dataDir, "studio-snippets");
  db = openRegistry(dataDir);
  boxId = insertBox(db, {
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
    adminSuperuser: true,
  }).id;
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function addProject(ref: string): number {
  return insertProject(db, {
    ref,
    name: ref,
    boxId,
    dbName: ref,
    ownerRole: `hs_${ref}_owner`,
    ownerPasswordEnc: "v1:iv:tag:pw",
  }).id;
}

function writeStudioTree(): void {
  mkdirSync(join(snippetsDir, "reports", "deep"), { recursive: true });
  writeFileSync(join(snippetsDir, "a.sql"), "select 1");
  writeFileSync(join(snippetsDir, "notes.txt"), "not a snippet");
  writeFileSync(join(snippetsDir, "reports", "daily.sql"), DAILY_SQL);
  writeFileSync(join(snippetsDir, "reports", "deep", "x.sql"), "select 'too deep'");
}

function allSnippets(projectId: number) {
  return [null, ...listFolders(db, projectId).map((folder) => folder.id)].flatMap(
    (folder) =>
      listSnippets(db, projectId, {
        folderId: folder,
        limit: 100,
        sortBy: "name",
        sortOrder: "asc",
        includeSql: false,
      }).items,
  );
}

describe("importStudioSnippets", () => {
  it("copies root snippets and one level of folders into every active project", () => {
    writeStudioTree();
    const alpha = addProject("alpha");
    const beta = addProject("beta");
    const gone = addProject("gone");
    markProjectDeleted(db, gone, "gone_deleted");

    expect(importStudioSnippets(db, snippetsDir)).toEqual({
      found: true,
      projects: 2,
      snippets: 2,
      folders: 1,
    });

    const reports = folderId("reports");
    for (const project of [alpha, beta]) {
      expect(listFolders(db, project).map((f) => [f.id, f.name])).toEqual([[reports, "reports"]]);
      expect(getSnippet(db, project, snippetId(null, "a"))).toMatchObject({
        name: "a",
        folderId: null,
        sql: "select 1",
      });
      expect(getSnippet(db, project, snippetId(reports, "daily"))).toMatchObject({
        name: "daily",
        folderId: reports,
        sql: DAILY_SQL,
      });
      expect(allSnippets(project)).toHaveLength(2);
    }
    expect(listFolders(db, gone)).toEqual([]);
    expect(allSnippets(gone)).toEqual([]);
    expect(getSetting(db, "snippets_imported")).toBeDefined();
  });

  it("imports only once", () => {
    writeStudioTree();
    const alpha = addProject("alpha");
    importStudioSnippets(db, snippetsDir);
    const later = addProject("later");

    expect(importStudioSnippets(db, snippetsDir)).toBeUndefined();

    expect(allSnippets(alpha)).toHaveLength(2);
    expect(listFolders(db, alpha)).toHaveLength(1);
    expect(allSnippets(later)).toEqual([]);
    expect(listFolders(db, later)).toEqual([]);
  });

  it("sets the marker when the folder is missing", () => {
    addProject("alpha");

    expect(importStudioSnippets(db, snippetsDir)).toEqual({
      found: false,
      projects: 1,
      snippets: 0,
      folders: 0,
    });
    expect(getSetting(db, "snippets_imported")).toBeDefined();
  });

  it("sets the marker when the folder is empty", () => {
    mkdirSync(snippetsDir);
    addProject("alpha");

    expect(importStudioSnippets(db, snippetsDir)).toEqual({
      found: true,
      projects: 1,
      snippets: 0,
      folders: 0,
    });
    expect(getSetting(db, "snippets_imported")).toBeDefined();
  });

  it("skips a snippet whose name is invalid", () => {
    mkdirSync(snippetsDir);
    writeFileSync(join(snippetsDir, ".sql"), "select 'nameless'");
    writeFileSync(join(snippetsDir, "ok.sql"), "select 1");
    const alpha = addProject("alpha");

    expect(importStudioSnippets(db, snippetsDir)).toEqual({
      found: true,
      projects: 1,
      snippets: 1,
      folders: 0,
    });
    expect(allSnippets(alpha).map((s) => s.name)).toEqual(["ok"]);
  });
});
