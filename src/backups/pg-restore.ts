import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoxConnection } from "../boxes/admin-client.js";
import { libpqEnv } from "./pg-dump.js";
import { redact } from "./redact.js";

const STDERR_TAIL_BYTES = 4096;

export class RestoreError extends Error {
  override name = "RestoreError";
}

// The baseline (§7 step 4) already made the extensions schema in the new database, and the owner
// role cannot comment on extensions it does not own: either entry would fail the restore.
// pg_stat_statements is the baseline's too: it is absent where the admin is not a superuser, and
// the owner role may never create it.
const BASELINE_ENTRIES = [
  /^\d+; \d+ \d+ SCHEMA - extensions /,
  /^\d+; \d+ \d+ EXTENSION - pg_stat_statements /,
  /^\d+; \d+ \d+ COMMENT - EXTENSION /,
];

export function restoreList(toc: string): string {
  return toc
    .split("\n")
    .filter((line) => !BASELINE_ENTRIES.some((entry) => entry.test(line)))
    .join("\n");
}

const ERROR_PREFIX = "pg_restore: error: ";
// pg_restore 17+ sets parameters, such as transaction_timeout, that an older server does not know.
const VERSION_SKEW_ERROR =
  /^pg_restore: error: could not execute query: ERROR: {2}unrecognized configuration parameter "[^"]+"$/;
const IGNORED_ERRORS = /^pg_restore: warning: errors ignored on restore: (\d+)$/gm;

function errorLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith(ERROR_PREFIX))
    .map((line) => line.slice(ERROR_PREFIX.length));
}

// stderr is only a tail, so pg_restore's own error count has to match the errors kept: a real error
// cut off the front would otherwise let the restore pass.
export function onlyVersionSkewErrors(stderr: string): boolean {
  const lines = stderr.split("\n");
  const errors = lines.flatMap((line, index) => (line.startsWith(ERROR_PREFIX) ? [index] : []));
  // The last count is pg_restore's own: a failed command echoed above it can contain any text.
  const ignored = Number([...stderr.matchAll(IGNORED_ERRORS)].at(-1)?.[1]);
  return (
    errors.length > 0 &&
    ignored === errors.length &&
    errors.every(
      (index) =>
        VERSION_SKEW_ERROR.test(lines[index] ?? "") &&
        (lines[index + 1] ?? "").startsWith("Command was: SET "),
    )
  );
}

// Without a connection pg_restore only reads the archive, so it gets no credentials at all.
function runPgRestore(
  pgBinDir: string,
  args: string[],
  conn?: BoxConnection,
  database = "postgres",
): Promise<string> {
  const child = spawn(join(pgBinDir, "pg_restore"), ["--no-password", ...args], {
    env: conn === undefined ? { PATH: process.env.PATH } : libpqEnv(conn, database),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  const fail = (message: string) => new RestoreError(redact(message, [conn?.password ?? ""]));
  return new Promise((resolve, reject) => {
    child.on("error", (error) => reject(fail(`could not run pg_restore: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else if (code === 1 && conn !== undefined && onlyVersionSkewErrors(stderr)) {
        console.warn(
          redact(
            `hattisar: restore into ${database} ignored settings the server does not know: ${errorLines(stderr).join("; ")}`,
            [conn.password],
          ),
        );
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else
        reject(
          fail(
            `pg_restore exited with ${code === null ? signal : `code ${code}`}: ${stderr.trim()}`,
          ),
        );
    });
  });
}

// Reads the archive's table of contents, so a file that is not a dump fails before anything on the
// box has changed.
export async function writeRestoreList(
  pgBinDir: string,
  archive: string,
  listFile: string,
): Promise<void> {
  const toc = await runPgRestore(pgBinDir, ["--list", archive]);
  await writeFile(listFile, restoreList(toc));
}

export async function restoreArchive(
  pgBinDir: string,
  conn: BoxConnection,
  target: { dbName: string; ownerRole: string },
  archive: string,
  listFile: string,
): Promise<void> {
  await runPgRestore(
    pgBinDir,
    [
      "--no-owner",
      "--no-privileges",
      `--role=${target.ownerRole}`,
      `--use-list=${listFile}`,
      `--dbname=${target.dbName}`,
      archive,
    ],
    conn,
    target.dbName,
  );
}
