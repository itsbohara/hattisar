import { spawn } from "node:child_process";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import type { BoxConnection } from "../boxes/admin-client.js";
import { redact } from "./redact.js";

const STDERR_TAIL_BYTES = 4096;
const CONNECT_TIMEOUT_SECONDS = "10";

export class DumpError extends Error {
  override name = "DumpError";
}

export interface RunningDump {
  stream: Readable;
  bytes: () => number;
  exited: Promise<number | NodeJS.Signals | null>;
}

// The child gets only libpq's variables: hattisar's own env holds the secret key and box passwords.
function dumpEnv(conn: BoxConnection, database: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.user,
    PGPASSWORD: conn.password,
    PGDATABASE: database,
    PGSSLMODE: conn.sslmode,
    PGCONNECT_TIMEOUT: CONNECT_TIMEOUT_SECONDS,
    // libpq's verify-full otherwise looks for ~/.postgresql/root.crt; node-postgres uses system CAs.
    ...(conn.sslmode === "verify-full" ? { PGSSLROOTCERT: "system" } : {}),
  };
}

// The stream ends only after pg_dump exits 0; any other exit errors it, so a consumer never
// mistakes a truncated archive for a complete one. Destroying the stream kills pg_dump.
export function startDump(pgBinDir: string, conn: BoxConnection, database: string): RunningDump {
  const child = spawn(join(pgBinDir, "pg_dump"), ["-Fc", "--no-password"], {
    env: dumpEnv(conn, database),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stream = new PassThrough();
  let bytes = 0;
  let stderr = "";
  const fail = (message: string) => stream.destroy(new DumpError(redact(message, [conn.password])));

  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  child.stdout.pipe(stream, { end: false });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exited = new Promise<number | NodeJS.Signals | null>((resolve) => {
    child.on("error", (error) => {
      fail(`could not run pg_dump: ${error.message}`);
      resolve(null);
    });
    child.on("close", (code, signal) => {
      if (code === 0) stream.end();
      else fail(`pg_dump exited with ${code === null ? signal : `code ${code}`}: ${stderr.trim()}`);
      resolve(code ?? signal);
    });
  });
  stream.on("close", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return { stream, bytes: () => bytes, exited };
}
