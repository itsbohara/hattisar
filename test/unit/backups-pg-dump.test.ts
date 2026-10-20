import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DumpError, startDump } from "../../src/backups/pg-dump.js";
import type { BoxConnection } from "../../src/boxes/admin-client.js";

const conn: BoxConnection = {
  host: "db.internal",
  port: 6432,
  user: "box_admin",
  password: "s3cret-Pa55word",
  sslmode: "verify-full",
};

let binDir: string;

// A stand-in pg_dump: prints its argv and the libpq env it was given, then runs `body`.
function fakePgDump(body: string): void {
  const script = `#!/bin/sh
echo "argv:$*"
echo "env:$PGHOST|$PGPORT|$PGUSER|$PGDATABASE|$PGSSLMODE|$PGSSLROOTCERT|$PGPASSWORD|$HATTISAR_SECRET_KEY"
${body}
`;
  const path = join(binDir, "pg_dump");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "hattisar-pgdump-"));
  process.env.HATTISAR_SECRET_KEY = "not-for-children";
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  delete process.env.HATTISAR_SECRET_KEY;
});

describe("startDump", () => {
  it("passes connection params through env, the password never in argv", async () => {
    fakePgDump("exit 0");
    const dump = startDump(binDir, conn, "my_app");
    const output = await text(dump.stream);
    expect(output).toContain("argv:-Fc --no-password\n");
    expect(output).not.toMatch(/argv:.*s3cret/);
    expect(output).toContain(
      "env:db.internal|6432|box_admin|my_app|verify-full|system|s3cret-Pa55word|\n",
    );
    expect(dump.bytes()).toBe(Buffer.byteLength(output));
  });

  it("does not set a root certificate below verify-full", async () => {
    fakePgDump("exit 0");
    const output = await text(startDump(binDir, { ...conn, sslmode: "require" }, "my_app").stream);
    expect(output).toContain("|require||");
  });

  it("errors the stream instead of ending it when pg_dump exits non-zero", async () => {
    fakePgDump(`echo "pg_dump: error: password $PGPASSWORD rejected" >&2; exit 1`);
    const dump = startDump(binDir, conn, "my_app");
    const error = await text(dump.stream).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DumpError);
    const message = (error as Error).message;
    expect(message).toContain("pg_dump exited with code 1");
    expect(message).toContain("password ******** rejected");
    expect(message).not.toContain(conn.password);
  });

  it("keeps only the tail of a long stderr", async () => {
    fakePgDump(`i=0; while [ $i -lt 2000 ]; do echo "noise line $i" >&2; i=$((i+1)); done; exit 2`);
    const error = (await text(startDump(binDir, conn, "my_app").stream).catch((e) => e)) as Error;
    expect(error.message.length).toBeLessThan(5000);
    expect(error.message).toContain("noise line 1999");
  });

  it("reports a missing pg_dump binary", async () => {
    const error = (await text(startDump(binDir, conn, "my_app").stream).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(DumpError);
    expect(error.message).toContain("could not run pg_dump");
  });

  it("kills pg_dump when the consumer gives up", async () => {
    fakePgDump("exec sleep 30");
    const dump = startDump(binDir, conn, "my_app");
    dump.stream.destroy();
    await expect(dump.exited).resolves.toBe("SIGTERM");
  });
});
