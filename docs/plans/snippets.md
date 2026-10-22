# Per-project SQL Snippets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each project's SQL editor lists and saves only that project's snippets: hattisar answers Studio's content API from the registry, scoped by ref, and imports Studio's shared folder once into every active project.

**Architecture:** A registry migration adds `snippet_folders` and `snippets` keyed by (project, id) with `ON DELETE CASCADE`; `src/registry/snippets.ts` is the store; `src/snippets/ids.ts` ports Studio's deterministic ids. `classifyRequest` gets a `project-content` route that `studio-handler` sends to `src/studio/content.ts`, never to Studio. `src/snippets/import.ts` copies the read-only `studio-snippets` volume once at boot.

**Tech Stack:** TypeScript, Hono, better-sqlite3, vitest, Playwright.

**Spec:** `docs/design.md` §3 (routing row), §3.3 (SQL snippets). Issue #20.

## Global Constraints

- Wire contract, status codes and shapes exactly as §3.3; Snippet/Folder shapes as §3.3 (constants `project_id:1`, `owner_id:1`, `visibility:"user"`, `favorite:false`, `description:""`, `type:"sql"`, `content.schema_version:"1.0"`).
- Ids: Studio's `generateDeterministicUuid` — snippet `[folder_id, name + ".sql"]` (folder_id `null` at root), folder `[name]`; byte-identical to Studio's for the same inputs.
- Fail closed: every request under `/api/platform/projects/:ref/content` is answered by hattisar; an unlisted method or sub-path → 404; nothing under it reaches Studio. Unknown/deleted/forbidden ref → 404 (same check as other project routes).
- Names: non-empty, no `/`, no NUL. Folders one level. Body limit 5 MB.
- Registry: migration file `004_snippets.sql`; `PRIMARY KEY (project_id, id)` on both tables; `UNIQUE (project_id, name)` on folders; snippets unique on (project, folder, name) including root (NULL folder must not escape uniqueness); `REFERENCES projects (id) ON DELETE CASCADE`; snippet `folder_id` references the folder within the same project, deleting the folder deletes its snippets.
- Import: dir `/studio-snippets`; setting key `snippets_imported`; runs once at boot before serving; into every project with status `active`; root `*.sql` and one level of folders, other files ignored; marker set even when the dir is empty or missing.
- Repo rules: commits split by layer, no co-author footer, comments only for traps / non-local reasons, Biome-clean, escape all SQL (better-sqlite3 parameters only).

## Review Focus

1. Project A's snippet must never be readable, listable, countable, updatable or deletable through project B's ref, even with the same id (ids collide across projects by design). → Task 2 handler tests: same-name snippet in A and B; every route through B sees only B's; delete via B leaves A's.
2. An id computed by the browser must equal the server's, or Studio's optimistic save/rename breaks. → Task 1 test vectors taken from the pinned Studio's own function.
3. A rename/move (PUT with a new name or folder, same old id) must not leave the old row behind or clash with an existing name. → Task 1 store test + Task 2 PUT test (409 on clash, old id gone on success).
4. Deleting a folder must delete its snippets, and purging a project must delete its snippets and folders. → Task 1 tests (folder delete cascade; project row delete cascade).
5. Re-running boot must not import twice, and a project created after the import gets nothing. → Task 3 tests.

---

### Task 1: Snippet ids and the registry store

**Files:**
- Create: `src/registry/migrations/004_snippets.sql`, `src/registry/snippets.ts`, `src/snippets/ids.ts`
- Test: `test/unit/snippets-ids.test.ts`, `test/unit/registry-snippets.test.ts`

**Interfaces:**
- Produces `snippetId(folderId: string | null, name: string): string` and `folderId(name: string): string` in `src/snippets/ids.ts`.
- Produces in `src/registry/snippets.ts` (all take `db: Registry, projectId: number` first):
  - `listSnippets(…, q: { name?: string; folderId?: string | null; limit: number; cursor?: string; sortBy: "name" | "inserted_at"; sortOrder: "asc" | "desc"; includeSql: boolean }): { items: SnippetRow[]; cursor?: string }` — `name` searches all folders (case-insensitive substring); without `name`, only `folderId` (default root). `cursor` = id of the previous page's last item; returned `cursor` present only when another page exists.
  - `getSnippet(…, id): SnippetRow | undefined`, `countSnippets(…, name?: string): number`
  - `saveSnippet(…, input: { id: string; name: string; sql: string; folderId: string | null }): SaveResult` where `SaveResult = { ok: true; snippet: SnippetRow } | { ok: false; reason: "name-taken" | "unknown-folder" | "invalid-name" }`. Upsert by `id`: when the row exists and name/folder changed, the stored row's id becomes `snippetId(folderId, name)` (Studio's client recomputes it) while `inserted_at` is kept; otherwise insert.
  - `deleteSnippets(…, ids: string[]): string[]` (ids actually deleted)
  - `listFolders(…): FolderRow[]`, `createFolder(…, name): { ok: true; folder: FolderRow } | { ok: false; reason: "name-taken" | "invalid-name" }`, `renameFolder(…, id, name): boolean`, `deleteFolders(…, ids: string[]): void`
  - `SnippetRow = { id; folderId: string | null; name; sql; insertedAt: string; updatedAt: string }`, `FolderRow = { id; name; createdAt: string }`.
  - Folder rename changes the folder's name but **not** its id or its snippets' ids (Studio never renames, so no client id depends on it).

- [ ] **Step 1: Extract id vectors from Studio.** In a throwaway `docker run --rm --entrypoint node supabase/studio:2026.10.12-sha-3699278 …`, load the chunk containing module 703627 (`generateDeterministicUuid`, see `/app/apps/studio/.next/server/chunks`) or reproduce its call through the module system, and record outputs for: `[null,"a.sql"]`, `[null,"Untitled query.sql"]`, `["<folderId of 'reports'>","daily.sql"]`, `["reports"]`, `["Ünïcödé 名前"]`, `[null,""]`. If loading the module proves impossible, copy the minified function body into the test as the oracle and say so in the report.
- [ ] **Step 2: Failing tests.** `snippets-ids.test.ts`: each vector equals the recorded value; output matches the uuid v4 regex. `registry-snippets.test.ts` (fresh `openRegistry` in a temp dir, two projects inserted via existing repo helpers):
  - same name in A and B → separate rows, same id; each project lists only its own.
  - list: root only without `name`; `name` matches across folders case-insensitively; sort/order; `limit` + `cursor` pages cover every row exactly once.
  - save: rename keeps `insertedAt`, old id gone, new id = `snippetId(folder, newName)`; name clash in the same folder → `name-taken` (root included); unknown folder → `unknown-folder`; names `""`, `"a/b"`, `"a\0"` → `invalid-name`.
  - folders: duplicate name → `name-taken`; delete removes its snippets; rename keeps ids.
  - deleting the project row removes its snippets and folders.
- [ ] **Step 3:** run → FAIL.
- [ ] **Step 4: Implement.** Port the id function faithfully (31-bit string hash seeding an LCG feeding uuid v4 bytes — match Studio exactly). Root-name uniqueness: a generated column or a partial unique index on `(project_id, name) WHERE folder_id IS NULL` plus `(project_id, folder_id, name)`. Timestamps ISO strings.
- [ ] **Step 5:** tests PASS; `pnpm test`, `pnpm lint`, `pnpm typecheck` clean.
- [ ] **Step 6: Commit** `feat(db): add snippet and snippet folder tables` (migration), `feat(snippets): derive snippet ids the way Studio does` (ids), `feat(snippets): store snippets per project` (repo), `test: cover snippet ids and the snippet store`.

### Task 2: Serve the content API per project

**Files:**
- Modify: `src/studio/routes.ts` (route kind `{ kind: "project-content"; ref: string; rest: string }` for `/api/platform/projects/:ref/content` and `…/content/*`, before `project-api-pass`), `src/studio/studio-handler.ts` (dispatch after the ref check)
- Create: `src/studio/content.ts`
- Test: `test/unit/studio-routes.test.ts` (classification), `test/unit/studio-content.test.ts` (handler through the app, like `studio-handler.test.ts`)

**Interfaces:**
- Consumes Task 1's store and ids.
- Produces `handleContent(c: Context, db: Registry, project: Project, method: string, rest: string): Promise<Response>`.

- [ ] **Step 1: Failing tests.** Classification: `GET|PUT|DELETE /api/platform/projects/abc/content`, `GET …/content/item/x`, `POST …/content/folders` → `project-content`; `/api/v1/projects/abc/content` stays `project-api-pass`. Handler, with Studio's URL pointed at a server that fails the test if called:
  - every row of §3.3's table: status and body shape (assert exact keys of Snippet and Folder).
  - Review Focus 1: A and B each have `x.sql`; through B, `GET content`, `item/:id`, `count`, `folders`, `PUT` and `DELETE` see and touch only B's; A's row unchanged after B's delete.
  - Review Focus 3: PUT with the old id and a new name → 200 with the new id; old id → 404; PUT to a name taken in that folder → 409.
  - unlisted method/sub-path (`PATCH content`, `GET content/nope`, `POST content/item/x`) → 404 and Studio not called; unknown and deleted ref → 404.
  - `limit=0` and `limit=1001` → 400 `{data:[]}`; `visibility=project` → `{data:[]}`; a body over 5 MB → 413.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** `content.ts`: parse query and body with the existing validation style in `src/studio/` (no new dependency unless one is already used there); map store results to §3.3 shapes; `owner`/`updated_by` = `{id:1, username:<session username or "admin">}`; `content_id` a fresh `crypto.randomUUID()` per response (Studio does the same).
- [ ] **Step 4:** tests PASS; `pnpm test`, `pnpm lint`, `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(studio): route the content API to hattisar` (routes + handler dispatch), `feat(studio): answer the SQL editor's snippet API per project` (content.ts), `test: cover per-project snippets through the proxy`.

### Task 3: Import Studio's shared snippets once

**Files:**
- Create: `src/snippets/import.ts`
- Modify: `src/main.ts` (call before the server listens), `docker/compose.yml` (hattisar mounts `studio-snippets:/studio-snippets:ro`)
- Test: `test/unit/snippets-import.test.ts`

**Interfaces:**
- Produces `importStudioSnippets(db: Registry, dir: string): { projects: number; snippets: number; folders: number } | undefined` — `undefined` when `snippets_imported` was already set.

- [ ] **Step 1: Failing tests** (temp dir as the volume, fresh registry):
  - root `a.sql`, `reports/daily.sql`, `notes.txt`, `reports/deep/x.sql` with two active projects and one deleted → both active projects get `a` (root) and `daily` in folder `reports` with Studio's ids and SQL bytes; `notes.txt` and the nested file ignored; the deleted project gets nothing; marker set.
  - second call → `undefined`, no duplicates; a project created after the first call gets nothing.
  - missing dir and empty dir → zero counts, marker set.
  - a name that fails validation (e.g. a file named `.sql`) is skipped, not fatal.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**; one transaction; log one line with the counts (no SQL content in logs). `main.ts` passes `/studio-snippets`.
- [ ] **Step 4:** tests PASS; `docker compose --env-file docker/env.example -f docker/compose.yml config` shows the read-only mount; `pnpm test`, `pnpm lint`, `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(snippets): import Studio's shared snippets once` (import + main), `chore(docker): mount Studio's snippets read-only into hattisar`, `test: cover the snippet import`.

### Task 4: End to end and docs

**Files:**
- Modify: `e2e/studio-polish.spec.ts` (the existing "Studio saves a SQL snippet" test), `README.md` (drop the "SQL snippets are shared" limitation; one line that snippets are per project and backed up with `hattisar-data`), `GOAL.md`/`TASK.md` only if they mention the limitation.

- [ ] **Step 1:** e2e: save a snippet through Studio's SQL editor in project A (UI, as the existing test does); open project B's SQL editor → the snippet is not listed; back in A → listed; delete it in A. Keep the existing PUT/DELETE status assertions.
- [ ] **Step 2:** `pnpm lint`, `pnpm typecheck`, `pnpm test`. Do not run `pnpm test:e2e` or rebuild the local stack; CI's `stack` job runs the e2e suite on the PR.
- [ ] **Step 3: Commit** `test(e2e): snippets stay in their project`, `docs: snippets are per project`.
