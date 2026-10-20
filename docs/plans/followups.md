# Plan: v1 follow-ups (#2–#5)

Spec: `docs/design.md` (binding). Each task closes one GitHub issue; read the issue with
`gh issue view <n>` for the problem statement.

## Global constraints

- Match the surrounding code: Hono, plain functions taking `deps`, result objects
  (`{ ok: false, problem }`) rather than thrown errors on expected failures.
- Unit tests in `test/unit` (vitest) prove each change. Run `pnpm test`, `pnpm typecheck` and
  `pnpm lint` before reporting.
- **Do not run `pnpm test:it`, `pnpm test:e2e` or any `docker` command.** The developer is using
  the running dev stack, and the integration suite recreates its containers. CI runs the integration
  and e2e suites when the branch is pushed. You may add or adjust an integration test when a unit
  test cannot prove the behaviour, but say in your report that it has not been run.
- Do not commit. The controller commits.
- Keep `docs/design.md` true: when a task changes behaviour the spec describes, update the spec
  section in the same change.

## Task 1: Per-project lifecycle lock (#2)

**Problem.** `busyReason` (`src/backups/service.ts`) only knows about running backups and the
in-memory `restoring` set. Soft delete, undelete, purge and password rotation check it but never
register themselves, so for example a restore that starts while a soft delete is between its
busy check and `markProjectDeleted` passes the check. Its `DROP DATABASE IF EXISTS` then misses the
already-renamed database and `createProjectDatabase` creates a fresh one under the original name: an
orphaned database for a project the registry says is deleted.

**Ruling.** Replace the `restoring` set with one in-process, per-project operation registry (the
app is a single process with one SQLite registry, so in-memory is sufficient — say so in a short
comment, since a second replica would break it). Every operation that changes a project's
database or owner role holds it for its whole duration: restore into project, the restore step of
restore-into-new-project, soft delete, undelete (restore from trash), purge (manual and the hourly
auto-purge), and password rotation. Starting a manual backup while one of those holds the project
is refused the same way. A second operation never waits; it gets the existing busy problem text,
naming what holds the project (e.g. "it is being deleted").

After taking the lock, an operation re-reads the project from the registry and refuses if its
status no longer allows the operation (restore into a project that is now deleted, for example).

**Tests.** Unit tests with the existing fakes: start operation A with an `admin` fake that blocks
on a promise, start operation B for the same project, assert B is refused with the busy problem
and makes no `admin` call; release A; assert the lock is free afterwards, including when A throws.
Cover at least delete-then-restore (the issue's race), restore-then-delete, and rotate-during-delete.
Operations on different projects must not block each other.

## Task 2: Timeouts on postgres-meta requests (#3)

**Problem.** `runQuery` and `generateTypescriptTypes` in `src/studio/pg-meta.ts` call
postgres-meta with a bare `fetch`. A hung postgres-meta or box leaves Studio spinning forever.

**Ruling.** Add `HATTISAR_PG_META_TIMEOUT_SECONDS` to `src/config.ts` (positive integer, default
`120` — a backstop above postgres-meta's own query timeout, long enough for legitimate long
SQL editor statements). Pass `AbortSignal.timeout(...)` to both fetches, covering the body read
too. A timeout answers 504 in each function's existing error shape, with a message like
`postgres-meta did not answer within 120 s`. Other fetch errors keep their current 500.
Document the variable in the README's configuration table and in `docs/design.md` where config
is listed. Do not add a timeout to the Studio proxy in `src/studio/proxy.ts`.

**Tests.** Unit tests against a local HTTP server that accepts and never answers (and one that
sends headers then stalls the body), with a short timeout, asserting the 504 shape and that the
test finishes well inside a few seconds. Config tests for default, valid and invalid values.

## Task 3: Clear leftover restore temp dirs on boot (#4)

**Problem.** `inWorkDir` in `src/backups/restore.ts` removes its `restore-*` directory in a
`finally`, which never runs when the process is killed mid-restore. Dumps can be many GB.

**Ruling.** Export a `removeStaleRestoreDirs(dataDir)` from `src/backups/restore.ts` that deletes
directories directly under `dataDir` whose name starts with `restore-`, and call it from
`seededRegistry` in `src/main.ts` beside `failInterruptedBackups`, before any job or request can
start a restore. Only `restore-*` directories go; files, other directories and a regular file named
`restore-x` are left alone. A failure to remove one is logged and does not stop boot.

**Tests.** Unit test on a temp data dir: stale `restore-a/backup.dump` and `restore-b/` removed;
`registry.db`, `other/` and a file `restore-note` untouched.

## Task 4: Decrypt owner passwords lazily (#5)

**Problem.** `RegistryProjectSource.toStudio` (`src/projects/studio-source.ts`) decrypts every
owner password for `list()`. One corrupt secret (or a changed `HATTISAR_SECRET_KEY`) throws and
breaks Studio's whole project list.

**Ruling.** `list()` returns projects without credentials; only the paths that build a connection
for one ref decrypt. Split the Studio `Project` type in `src/studio/projects-source.ts` so the list
shape has no `ownerPassword` and the connection path gets it from `get()`. When `get()` cannot
decrypt, the request for that project fails with a readable error (Studio shows it) rather than a
500 stack, and every other project keeps working. Apply the same rule to hattisar's own project
page (`src/projects/routes.tsx`): a project whose secret will not decrypt still renders, with the
connection strings replaced by a short explanation and the rotate action available, since
rotating writes a fresh secret. Check that rotation itself does not need to decrypt the old one.

**Tests.** Unit tests: `list()` with one corrupt `ownerPasswordEnc` returns every project; the
Studio request for the corrupt ref returns the readable error; a good ref still connects; the
project page renders for the corrupt project.
