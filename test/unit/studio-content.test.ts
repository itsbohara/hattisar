import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject, markProjectDeleted } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { createFolder, getSnippet, saveSnippet } from "../../src/registry/snippets.js";
import { folderId, snippetId } from "../../src/snippets/ids.js";
import { signInToRegistry } from "../helpers/session.js";

const secretKey = deriveSecretKey("s".repeat(32));
const SNIPPET_KEYS = [
  "content",
  "description",
  "favorite",
  "folder_id",
  "id",
  "inserted_at",
  "name",
  "owner",
  "owner_id",
  "project_id",
  "type",
  "updated_at",
  "updated_by",
  "visibility",
];
const FOLDER_KEYS = ["id", "name", "owner_id", "parent_id", "project_id"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let studio: Server;
let studioCalls: string[] = [];
let app: ReturnType<typeof createApp>;
let dataDir: string;
let registry: Registry;
let cookie: string;
const ids: Record<string, number> = {};

beforeAll(async () => {
  studio = createServer((req, res) => {
    studioCalls.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => studio.listen(0, "127.0.0.1", resolve));
  const { port } = studio.address() as AddressInfo;
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-studio-content-"));
  registry = openRegistry(dataDir);
  cookie = signInToRegistry(registry);
  const box = insertBox(registry, {
    name: "shared",
    kind: "shared",
    devOnly: true,
    host: "db",
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: encryptSecret("pw", secretKey),
    sslmode: "disable",
    publicHost: "db.example.test",
    publicPort: 54322,
    poolerTenant: "hattisar",
    poolerSessionPort: 54322,
    poolerTransactionPort: 6543,
    containerName: null,
  });
  for (const ref of ["alpha", "bravo", "gone"]) {
    ids[ref] = insertProject(registry, {
      ref,
      name: ref,
      boxId: box.id,
      dbName: ref,
      ownerRole: `hs_${ref}_owner`,
      ownerPasswordEnc: encryptSecret("owner-pw", secretKey),
    }).id;
  }
  markProjectDeleted(registry, ids.gone as number, "gone__deleted_20261020");
  app = createApp(
    loadConfig({
      HATTISAR_SECRET_KEY: "s".repeat(32),
      PG_META_CRYPTO_KEY: "unit-test-crypto-key",
      POSTGRES_PASSWORD: "unused",
      POOLER_TENANT_ID: "hattisar",
      POOLER_JWT_SECRET: "pooler-jwt-secret",
      STUDIO_URL: `http://127.0.0.1:${port}`,
    }),
    registry,
  );
});

afterAll(() => {
  studio.close();
  registry.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  registry.prepare("DELETE FROM snippets").run();
  registry.prepare("DELETE FROM snippet_folders").run();
  studioCalls = [];
});

afterEach(() => {
  expect(studioCalls).toEqual([]);
});

function project(ref: string): number {
  return ids[ref] as number;
}

function request(ref: string, path: string, init?: RequestInit): Promise<Response> {
  return rawRequest(`/api/platform/projects/${ref}/content${path}`, init);
}

function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://hattisar.test");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return Promise.resolve(app.request(`http://hattisar.test${path}`, { ...init, headers }));
}

function seed(ref: string, name: string, sql: string, folder: string | null = null) {
  const result = saveSnippet(
    registry,
    project(ref),
    { id: snippetId(folder, name), name, sql, folderId: folder },
    "2026-10-01T00:00:00.000Z",
  );
  if (!result.ok) throw new Error(result.reason);
  return result.snippet;
}

function seedFolder(ref: string, name: string): string {
  const result = createFolder(registry, project(ref), name);
  if (!result.ok) throw new Error(result.reason);
  return result.folder.id;
}

function studioBody(name: string, sql: string, folder: string | null = null, id?: string) {
  return {
    id: id ?? snippetId(folder, name),
    type: "sql",
    name,
    description: "",
    visibility: "user",
    favorite: false,
    owner_id: 1,
    project_id: 1,
    folder_id: folder,
    inserted_at: "2026-10-22T00:00:00.000Z",
    updated_at: "2026-10-22T00:00:00.000Z",
    content: { schema_version: "1.0", content_id: "c1", sql },
  };
}

function put(ref: string, body: unknown): Promise<Response> {
  return request(ref, "", { method: "PUT", body: JSON.stringify(body) });
}

describe("GET content", () => {
  it("lists the project's root snippets as Studio snippets with content", async () => {
    const row = seed("alpha", "x", "select 1");
    const folder = seedFolder("alpha", "f");
    seed("alpha", "in-folder", "select 2", folder);

    const response = await request("alpha", "?type=sql&limit=100&sort_by=name&sort_order=asc");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown>[]; cursor?: string };
    expect(Object.keys(body)).toEqual(["data"]);
    expect(body.data).toHaveLength(1);
    const snippet = body.data[0] as Record<string, unknown>;
    expect(Object.keys(snippet).sort()).toEqual(SNIPPET_KEYS);
    expect(snippet).toEqual({
      id: row.id,
      inserted_at: row.insertedAt,
      updated_at: row.updatedAt,
      type: "sql",
      name: "x",
      description: "",
      favorite: false,
      visibility: "user",
      project_id: 1,
      folder_id: null,
      owner_id: 1,
      owner: { id: 1, username: "admin" },
      updated_by: { id: 1, username: "admin" },
      content: { sql: "select 1", content_id: expect.stringMatching(UUID), schema_version: "1.0" },
    });
  });

  it("searches every folder by name and pages with a cursor", async () => {
    const folder = seedFolder("alpha", "f");
    seed("alpha", "Report a", "1");
    seed("alpha", "report b", "2", folder);
    seed("alpha", "other", "3");

    const first = await request("alpha", "?name=REPORT&limit=1&sort_by=name&sort_order=asc");
    const page = (await first.json()) as { data: { name: string }[]; cursor?: string };
    expect(page.data.map((s) => s.name)).toEqual(["Report a"]);
    expect(page.cursor).toBe(snippetId(null, "Report a"));

    const second = await request(
      "alpha",
      `?name=REPORT&limit=1&sort_by=name&sort_order=asc&cursor=${page.cursor}`,
    );
    const next = (await second.json()) as { data: { name: string }[]; cursor?: string };
    expect(next.data.map((s) => s.name)).toEqual(["report b"]);
    expect(next.cursor).toBeUndefined();
  });

  it("sorts by inserted_at descending by default", async () => {
    saveSnippet(
      registry,
      project("alpha"),
      { id: snippetId(null, "old"), name: "old", sql: "", folderId: null },
      "2026-01-01T00:00:00.000Z",
    );
    saveSnippet(
      registry,
      project("alpha"),
      { id: snippetId(null, "new"), name: "new", sql: "", folderId: null },
      "2026-02-01T00:00:00.000Z",
    );
    const body = (await (await request("alpha", "")).json()) as { data: { name: string }[] };
    expect(body.data.map((s) => s.name)).toEqual(["new", "old"]);
  });

  it.each([
    "limit=0",
    "limit=1001",
    "limit=abc",
    "limit=",
    "limit=1e2",
    "limit=0x10",
    "limit=010",
    "limit=+5",
    "limit=%205",
    "sort_by=id",
    "sort_order=up",
    "visibility=org",
  ])("answers %s with 400 {data:[]}", async (query) => {
    seed("alpha", "x", "1");
    const response = await request("alpha", `?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ data: [] });
  });

  it("answers visibility=project with no snippets", async () => {
    seed("alpha", "x", "1");
    const response = await request("alpha", "?visibility=project");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
  });

  it("ignores type and favorite", async () => {
    seed("alpha", "x", "1");
    const body = (await (await request("alpha", "?type=report&favorite=true")).json()) as {
      data: unknown[];
    };
    expect(body.data).toHaveLength(1);
  });
});

describe("PUT content", () => {
  it("creates a snippet and returns it", async () => {
    const response = await put("alpha", studioBody("x", "select 1"));
    expect(response.status).toBe(200);
    const snippet = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(snippet).sort()).toEqual(SNIPPET_KEYS);
    expect(snippet).toMatchObject({
      id: snippetId(null, "x"),
      name: "x",
      folder_id: null,
      content: { sql: "select 1", schema_version: "1.0" },
    });
    expect(getSnippet(registry, project("alpha"), snippetId(null, "x"))?.sql).toBe("select 1");
  });

  it("creates a snippet in a folder", async () => {
    const folder = seedFolder("alpha", "f");
    const response = await put("alpha", studioBody("x", "1", folder));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: snippetId(folder, "x"), folder_id: folder });
  });

  it("updates the sql and keeps inserted_at", async () => {
    const row = seed("alpha", "x", "select 1");
    const response = await put("alpha", studioBody("x", "select 2"));
    expect(response.status).toBe(200);
    const snippet = (await response.json()) as Record<string, unknown>;
    expect(snippet).toMatchObject({ id: row.id, inserted_at: row.insertedAt });
    expect(snippet.content).toMatchObject({ sql: "select 2" });
  });

  it("renames by the old id: new id, old id gone", async () => {
    const old = seed("alpha", "x", "select 1");
    const response = await put("alpha", studioBody("y", "select 1", null, old.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: snippetId(null, "y"), name: "y" });
    expect((await request("alpha", `/item/${old.id}`)).status).toBe(404);
    expect((await request("alpha", `/item/${snippetId(null, "y")}`)).status).toBe(200);
  });

  it("refuses a rename onto a name taken in that folder with 409", async () => {
    const old = seed("alpha", "x", "1");
    seed("alpha", "y", "2");
    const response = await put("alpha", studioBody("y", "1", null, old.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(getSnippet(registry, project("alpha"), old.id)?.name).toBe("x");
  });

  it("refuses a new snippet whose name is taken in the folder with 409", async () => {
    seed("alpha", "x", "1");
    const other = "00000000-0000-4000-8000-000000000000";
    const response = await put("alpha", studioBody("x", "2", null, other));
    expect(response.status).toBe(409);
  });

  it.each([
    ["a name with a slash", studioBody("a/b", "1")],
    ["an empty name", studioBody("", "1")],
    ["a name with NUL", studioBody("a\0b", "1")],
    ["a non-uuid id", studioBody("x", "1", null, "not-a-uuid")],
    ["a type other than sql", { ...studioBody("x", "1"), type: "report" }],
    ["no content", { ...studioBody("x", "1"), content: undefined }],
    ["a body that is not an object", ["x"]],
  ])("refuses a new snippet with %s with 400 {error}", async (_, body) => {
    const response = await put("alpha", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it("refuses a body that is not JSON with 400", async () => {
    const response = await request("alpha", "", { method: "PUT", body: "{" });
    expect(response.status).toBe(400);
  });

  it("refuses an unknown folder with 400", async () => {
    const response = await put("alpha", studioBody("x", "1", folderId("nope")));
    expect(response.status).toBe(400);
  });

  it("refuses a body over 5 MB with 413", async () => {
    const response = await put("alpha", studioBody("x", "-".repeat(5 * 1024 * 1024)));
    expect(response.status).toBe(413);
    expect(getSnippet(registry, project("alpha"), snippetId(null, "x"))).toBeUndefined();
  });

  it("refuses a chunked body over 5 MB with 413", async () => {
    const chunk = new TextEncoder().encode("-".repeat(1024 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 6) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const response = await request("alpha", "", {
      method: "PUT",
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
  });

  it("stores a new snippet under the id its folder and name derive, not the id sent", async () => {
    const response = await put("alpha", studioBody("a", "select 'a'", null, snippetId(null, "c")));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: snippetId(null, "a"), name: "a" });
    expect(getSnippet(registry, project("alpha"), snippetId(null, "c"))).toBeUndefined();

    const c = await put("alpha", studioBody("c", "select 'c'"));
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ id: snippetId(null, "c"), name: "c" });
    expect(getSnippet(registry, project("alpha"), snippetId(null, "a"))).toMatchObject({
      name: "a",
      sql: "select 'a'",
    });
  });

  it("refuses a new snippet sent under another id whose name is taken with 409", async () => {
    seed("alpha", "a", "select 'a'");
    const response = await put("alpha", studioBody("a", "other", null, snippetId(null, "c")));
    expect(response.status).toBe(409);
    expect(getSnippet(registry, project("alpha"), snippetId(null, "a"))?.sql).toBe("select 'a'");
  });

  it("renames onto a name only while no snippet has it", async () => {
    const b = seed("alpha", "b", "select 'b'");
    seed("alpha", "c", "select 'c'");
    expect((await put("alpha", studioBody("c", "x", null, b.id))).status).toBe(409);
    await request("alpha", `?ids=${snippetId(null, "c")}`, { method: "DELETE" });
    const renamed = await put("alpha", studioBody("c", "x", null, b.id));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: snippetId(null, "c"), name: "c" });
  });

  it("accepts a body just under 5 MB", async () => {
    const response = await put("alpha", studioBody("x", "-".repeat(5 * 1024 * 1024 - 1024)));
    expect(response.status).toBe(200);
  });
});

describe("DELETE content", () => {
  it("deletes the listed snippets and answers [{id}]", async () => {
    const a = seed("alpha", "a", "1");
    const b = seed("alpha", "b", "2");
    seed("alpha", "c", "3");
    const response = await request("alpha", `?ids=${a.id},${b.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: a.id }, { id: b.id }]);
    expect(getSnippet(registry, project("alpha"), a.id)).toBeUndefined();
    expect(getSnippet(registry, project("alpha"), snippetId(null, "c"))).toBeDefined();
  });

  it.each([
    "",
    "?ids=",
    "?ids=not-a-uuid",
    `?ids=${snippetId(null, "a")},nope`,
    `?ids=${snippetId(null, "a")}&ids=${snippetId(null, "b")}`,
  ])("answers %s with 400", async (query) => {
    const response = await request("alpha", query, { method: "DELETE" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Snippet IDs are required" });
  });
});

describe("GET content/item/:id", () => {
  it("answers the snippet with content", async () => {
    const row = seed("alpha", "x", "select 1");
    const response = await request("alpha", `/item/${row.id}`);
    expect(response.status).toBe(200);
    const snippet = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(snippet).sort()).toEqual(SNIPPET_KEYS);
    expect(snippet.content).toMatchObject({ sql: "select 1" });
  });

  it("answers a missing id with 404", async () => {
    const response = await request("alpha", `/item/${snippetId(null, "x")}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Content not found." });
  });
});

describe("GET content/count", () => {
  it("counts every snippet as private without a name", async () => {
    const folder = seedFolder("alpha", "f");
    seed("alpha", "a", "1");
    seed("alpha", "b", "2", folder);
    const response = await request("alpha", "/count");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shared: 0, favorites: 0, private: 2 });
  });

  it("counts the name matches with a name", async () => {
    seed("alpha", "Report", "1");
    seed("alpha", "other", "2");
    expect(await (await request("alpha", "/count?name=rep")).json()).toEqual({ count: 1 });
  });
});

describe("content/folders", () => {
  it("lists root folders and root snippets without content", async () => {
    const folder = seedFolder("alpha", "f");
    seed("alpha", "root", "1");
    seed("alpha", "inner", "2", folder);
    const response = await request("alpha", "/folders?type=sql&limit=100&visibility=user");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { folders: Record<string, unknown>[]; contents: Record<string, unknown>[] };
    };
    expect(Object.keys(body)).toEqual(["data"]);
    expect(body.data.folders).toEqual([
      { id: folder, name: "f", owner_id: 1, parent_id: null, project_id: 1 },
    ]);
    expect(Object.keys(body.data.folders[0] as object).sort()).toEqual(FOLDER_KEYS);
    expect(body.data.contents.map((s) => s.name)).toEqual(["root"]);
    expect(Object.keys(body.data.contents[0] as object).sort()).toEqual(
      SNIPPET_KEYS.filter((key) => key !== "content"),
    );
  });

  it("pages the folder listing's snippets with a cursor", async () => {
    seed("alpha", "a", "1");
    seed("alpha", "b", "2");
    const body = (await (
      await request("alpha", "/folders?limit=1&sort_by=name&sort_order=asc")
    ).json()) as {
      data: { contents: { name: string }[] };
      cursor?: string;
    };
    expect(body.data.contents.map((s) => s.name)).toEqual(["a"]);
    expect(body.cursor).toBe(snippetId(null, "a"));
  });

  it("creates a folder with 201", async () => {
    const response = await request("alpha", "/folders", {
      method: "POST",
      body: JSON.stringify({ name: "f" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: folderId("f"),
      name: "f",
      owner_id: 1,
      parent_id: null,
      project_id: 1,
    });
  });

  it("refuses a duplicate folder name with 409", async () => {
    seedFolder("alpha", "f");
    const response = await request("alpha", "/folders", {
      method: "POST",
      body: JSON.stringify({ name: "f" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it.each([{ name: "a/b" }, { name: "" }, {}])("refuses folder body %j with 400", async (body) => {
    const response = await request("alpha", "/folders", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  });

  it("deletes folders and their snippets", async () => {
    const folder = seedFolder("alpha", "f");
    const kept = seedFolder("alpha", "g");
    const inner = seed("alpha", "inner", "1", folder);
    const response = await request("alpha", `/folders?ids=${folder}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(getSnippet(registry, project("alpha"), inner.id)).toBeUndefined();
    const listed = (await (await request("alpha", "/folders")).json()) as {
      data: { folders: { id: string }[] };
    };
    expect(listed.data.folders.map((f) => f.id)).toEqual([kept]);
  });

  it("ignores visibility on folder listings", async () => {
    const folder = seedFolder("alpha", "f");
    seed("alpha", "root", "1");
    for (const path of ["/folders?visibility=org", `/folders/${folder}?visibility=project`]) {
      expect((await request("alpha", path)).status).toBe(200);
    }
    const body = (await (await request("alpha", "/folders?visibility=project")).json()) as {
      data: { contents: unknown[] };
    };
    expect(body.data.contents).toHaveLength(1);
  });

  it("refuses repeated ids params on a folder delete with 400", async () => {
    const f = seedFolder("alpha", "f");
    const g = seedFolder("alpha", "g");
    const response = await request("alpha", `/folders?ids=${f}&ids=${g}`, { method: "DELETE" });
    expect(response.status).toBe(400);
  });

  it("refuses a folder delete without ids with 400", async () => {
    const response = await request("alpha", "/folders", { method: "DELETE" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Folder IDs are required" });
  });

  it("lists one folder's snippets", async () => {
    const folder = seedFolder("alpha", "f");
    seed("alpha", "root", "1");
    seed("alpha", "inner", "2", folder);
    const response = await request("alpha", `/folders/${folder}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { folders: unknown[]; contents: { name: string; folder_id: string }[] };
    };
    expect(body.data.folders).toEqual([]);
    expect(body.data.contents).toEqual([
      expect.objectContaining({ name: "inner", folder_id: folder }),
    ]);
  });

  it("renames a folder and keeps its id", async () => {
    const folder = seedFolder("alpha", "f");
    const response = await request("alpha", `/folders/${folder}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "g" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    const listed = (await (await request("alpha", "/folders")).json()) as {
      data: { folders: { id: string; name: string }[] };
    };
    expect(listed.data.folders).toEqual([expect.objectContaining({ id: folder, name: "g" })]);
  });

  it("refuses a folder rename onto a taken name with 409 and an unknown folder with 404", async () => {
    const folder = seedFolder("alpha", "f");
    seedFolder("alpha", "g");
    const taken = await request("alpha", `/folders/${folder}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "g" }),
    });
    expect(taken.status).toBe(409);
    const unknown = await request("alpha", `/folders/${folderId("nope")}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "h" }),
    });
    expect(unknown.status).toBe(404);
  });
});

describe("project isolation", () => {
  it("sees and touches only the ref's own snippets, even with the same id", async () => {
    const a = seed("alpha", "x.sql-name", "select 'alpha'");
    const b = seed("bravo", "x.sql-name", "select 'bravo'");
    expect(a.id).toBe(b.id);
    const onlyA = seed("alpha", "alpha-only", "1");

    const list = (await (await request("bravo", "")).json()) as {
      data: { content: { sql: string } }[];
    };
    expect(list.data.map((s) => s.content.sql)).toEqual(["select 'bravo'"]);

    const item = (await (await request("bravo", `/item/${b.id}`)).json()) as {
      content: { sql: string };
    };
    expect(item.content.sql).toBe("select 'bravo'");
    expect((await request("bravo", `/item/${onlyA.id}`)).status).toBe(404);

    expect(await (await request("bravo", "/count")).json()).toEqual({
      shared: 0,
      favorites: 0,
      private: 1,
    });
    expect(await (await request("bravo", "/count?name=alpha")).json()).toEqual({ count: 0 });

    const folders = (await (await request("bravo", "/folders")).json()) as {
      data: { contents: { name: string }[] };
    };
    expect(folders.data.contents.map((s) => s.name)).toEqual(["x.sql-name"]);

    const updated = await put("bravo", studioBody("x.sql-name", "select 'bravo 2'"));
    expect(updated.status).toBe(200);
    expect(getSnippet(registry, project("alpha"), a.id)?.sql).toBe("select 'alpha'");

    const deleted = await request("bravo", `?ids=${b.id},${onlyA.id}`, { method: "DELETE" });
    expect(await deleted.json()).toEqual([{ id: b.id }]);
    expect(getSnippet(registry, project("bravo"), b.id)).toBeUndefined();
    expect(getSnippet(registry, project("alpha"), a.id)).toMatchObject({
      name: "x.sql-name",
      sql: "select 'alpha'",
    });
    expect(getSnippet(registry, project("alpha"), onlyA.id)).toBeDefined();

    const putOnlyA = await put("bravo", studioBody("y", "z", null, onlyA.id));
    expect(putOnlyA.status).toBe(200);
    expect(getSnippet(registry, project("alpha"), onlyA.id)).toMatchObject({
      name: "alpha-only",
      sql: "1",
    });
  });

  it("keeps folders per project", async () => {
    const folder = seedFolder("alpha", "f");
    seed("alpha", "inner", "1", folder);

    const listed = (await (await request("bravo", "/folders")).json()) as {
      data: { folders: unknown[] };
    };
    expect(listed.data.folders).toEqual([]);
    const inFolder = (await (await request("bravo", `/folders/${folder}`)).json()) as {
      data: { contents: unknown[] };
    };
    expect(inFolder.data.contents).toEqual([]);
    expect((await put("bravo", studioBody("x", "1", folder))).status).toBe(400);

    const renamed = await request("bravo", `/folders/${folder}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "g" }),
    });
    expect(renamed.status).toBe(404);
    await request("bravo", `/folders?ids=${folder}`, { method: "DELETE" });
    const stillThere = (await (await request("alpha", "/folders")).json()) as {
      data: { folders: { name: string }[] };
    };
    expect(stillThere.data.folders.map((f) => f.name)).toEqual(["f"]);
    expect(getSnippet(registry, project("alpha"), snippetId(folder, "inner"))).toBeDefined();
  });
});

describe("fail closed", () => {
  it.each([
    "/API/platform/projects/alpha/content",
    "/api/Platform/Projects/alpha/CONTENT",
    "/api/platform/projects/alpha//content",
  ])("serves %s from the snippet store", async (path) => {
    seed("alpha", "x", "1");
    const response = await rawRequest(path);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it.each([
    "/API/platform/projects/nope/content",
    "/api/Platform/projects/gone/content/count",
    "/api/platform/projects/nope//content",
    "/api/platform/projects//content",
  ])("answers %s with 404", async (path) => {
    expect((await rawRequest(path)).status).toBe(404);
  });

  it.each([
    ["PATCH", ""],
    ["POST", ""],
    ["GET", "/nope"],
    ["GET", "/"],
    ["POST", "/item/x"],
    ["PUT", "/count"],
    ["PUT", "/folders"],
    ["DELETE", "/folders/x"],
    ["GET", "/item/x/y"],
    ["GET", "/folders/x/y"],
  ])("answers %s content%s with 404", async (method, path) => {
    const response = await request("alpha", path, {
      method,
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    expect(response.status).toBe(404);
  });

  it.each(["nope", "gone"])("answers an unknown or deleted ref (%s) with 404", async (ref) => {
    expect((await request(ref, "")).status).toBe(404);
    expect((await request(ref, "/count")).status).toBe(404);
    expect((await put(ref, studioBody("x", "1"))).status).toBe(404);
  });

  it("does not reveal a deleted project's snippets", async () => {
    saveSnippet(registry, project("gone"), {
      id: snippetId(null, "x"),
      name: "x",
      sql: "1",
      folderId: null,
    });
    const response = await request("gone", `/item/${snippetId(null, "x")}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Project not found" });
  });
});
