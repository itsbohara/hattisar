import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onlyVersionSkewErrors,
  RestoreError,
  restoreArchive,
  restoreList,
  writeRestoreList,
} from "../../src/backups/pg-restore.js";
import type { BoxConnection } from "../../src/boxes/admin-client.js";

// pg_restore --list of a project database: baseline objects plus a user table and function.
const TOC = `;
; Archive created at 2026-10-20 19:50:00 UTC
;
9; 2615 25135 SCHEMA - extensions supabase_admin
3473; 0 0 ACL - SCHEMA extensions supabase_admin
8; 2615 2200 SCHEMA - public exp_owner
4; 3079 25184 EXTENSION - pg_stat_statements 
3474; 0 0 COMMENT - EXTENSION pg_stat_statements 
2; 3079 25136 EXTENSION - pgcrypto 
3475; 0 0 COMMENT - EXTENSION pgcrypto 
3476; 0 0 COMMENT - EXTENSION "uuid-ossp" 
239; 1255 25313 FUNCTION public f() exp_owner
223; 1259 25307 TABLE public widgets exp_owner
224; 1259 25308 TABLE public extensions_log exp_owner
3465; 0 25307 TABLE DATA public widgets exp_owner`;

describe("restoreList", () => {
  it("drops the extensions schema, pg_stat_statements and extension comments, keeping everything else", () => {
    const kept = restoreList(TOC).split("\n");
    expect(kept).not.toContain("9; 2615 25135 SCHEMA - extensions supabase_admin");
    expect(kept).not.toContain("4; 3079 25184 EXTENSION - pg_stat_statements ");
    expect(kept.filter((line) => line.includes("COMMENT - EXTENSION"))).toEqual([]);
    expect(kept).toEqual(
      expect.arrayContaining([
        "3473; 0 0 ACL - SCHEMA extensions supabase_admin",
        "8; 2615 2200 SCHEMA - public exp_owner",
        "2; 3079 25136 EXTENSION - pgcrypto ",
        "239; 1255 25313 FUNCTION public f() exp_owner",
        "224; 1259 25308 TABLE public extensions_log exp_owner",
        "3465; 0 25307 TABLE DATA public widgets exp_owner",
      ]),
    );
    expect(kept).toHaveLength(TOC.split("\n").length - 5);
  });
});

// pg_restore 18 stderr from restoring a Postgres 17 dump into a Postgres 15 server.
const SKEW = `pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"
Command was: SET transaction_timeout = 0;
`;
const IGNORED = (count: number) => `pg_restore: warning: errors ignored on restore: ${count}\n`;
const REAL = `pg_restore: error: could not execute query: ERROR:  relation "widgets" already exists
Command was: CREATE TABLE public.widgets (
    id integer NOT NULL
);


`;

describe("onlyVersionSkewErrors", () => {
  it("is true when every error is an unrecognized configuration parameter", () => {
    expect(onlyVersionSkewErrors(SKEW + IGNORED(1))).toBe(true);
    const twoSets = `${SKEW}${SKEW.replaceAll("transaction_timeout", "idle_session_timeout")}`;
    expect(onlyVersionSkewErrors(twoSets + IGNORED(2))).toBe(true);
  });

  it("is false when any other error is present", () => {
    expect(onlyVersionSkewErrors(SKEW + REAL + IGNORED(2))).toBe(false);
    expect(onlyVersionSkewErrors(REAL + SKEW + IGNORED(2))).toBe(false);
  });

  it("is false for an unknown parameter outside pg_restore's own SET", () => {
    const inFunction = SKEW.replace("SET transaction_timeout = 0;", "CREATE FUNCTION public.f()");
    expect(onlyVersionSkewErrors(inFunction + IGNORED(1))).toBe(false);
  });

  it("is false when pg_restore counted more errors than the kept stderr shows", () => {
    expect(onlyVersionSkewErrors(SKEW + IGNORED(2))).toBe(false);
    const cutOff = `rror: could not execute query: ERROR:  permission denied\n${SKEW}${IGNORED(2)}`;
    expect(onlyVersionSkewErrors(cutOff)).toBe(false);
  });

  it("reads pg_restore's own count, not one echoed from a failed command", () => {
    const echoed = `rror: could not execute query: ERROR:  syntax error
Command was: SELECT '
${IGNORED(1)}';
${SKEW}${IGNORED(2)}`;
    expect(onlyVersionSkewErrors(echoed)).toBe(false);
  });

  it("is false without a count of ignored errors", () => {
    expect(onlyVersionSkewErrors(SKEW)).toBe(false);
  });

  it("is false when there are no errors", () => {
    expect(onlyVersionSkewErrors("")).toBe(false);
    expect(onlyVersionSkewErrors(IGNORED(0))).toBe(false);
    expect(onlyVersionSkewErrors("pg_restore: error: connection to server failed\n")).toBe(false);
  });
});

const conn: BoxConnection = {
  host: "db.internal",
  port: 5432,
  user: "box_admin",
  password: "s3cret-Pa55word",
  sslmode: "disable",
};
const target = { dbName: "my_app", ownerRole: "my_app_owner" };
let binDir: string;

// A stand-in pg_restore: writes `stderr` (with $PGPASSWORD expanded) and exits with `code`.
function fakePgRestore(stderr: string, code: number): void {
  const path = join(binDir, "pg_restore");
  writeFileSync(path, `#!/bin/sh\ncat >&2 <<EOF\n${stderr}EOF\nexit ${code}\n`);
  chmodSync(path, 0o755);
}

function restore(): Promise<void> {
  return restoreArchive(binDir, conn, target, join(binDir, "a.dump"), join(binDir, "a.list"));
}

describe("pg_restore exit codes", () => {
  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "hattisar-pgrestore-"));
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("treats a restore whose only errors are version skew as done, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakePgRestore(`${SKEW.replaceAll("transaction_timeout", "$PGPASSWORD")}${IGNORED(1)}`, 1);
    await expect(restore()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("my_app");
    expect(message).toContain('unrecognized configuration parameter "********"');
    expect(message).not.toContain(conn.password);
  });

  it("still fails a restore with a real error next to the version skew", async () => {
    fakePgRestore(SKEW + REAL + IGNORED(2), 1);
    const error = await restore().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RestoreError);
    expect((error as Error).message).toContain('relation "widgets" already exists');
  });

  it("does not tolerate version skew from a run that is not exit code 1", async () => {
    fakePgRestore(SKEW + IGNORED(1), 2);
    await expect(restore()).rejects.toBeInstanceOf(RestoreError);
  });

  it("never tolerates errors while listing an archive", async () => {
    fakePgRestore(SKEW + IGNORED(1), 1);
    const list = writeRestoreList(binDir, join(binDir, "a.dump"), join(binDir, "a.list"));
    await expect(list).rejects.toBeInstanceOf(RestoreError);
  });
});
