import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Io, run } from "../../cli/src/run.js";
import { createApp } from "../../src/app.js";
import { createApiToken } from "../../src/auth/api-tokens.js";
import { saveS3Settings } from "../../src/backups/s3-settings.js";
import type { AdminClientRunner } from "../../src/boxes/admin-client.js";
import { loadConfig } from "../../src/config.js";
import { getBackup } from "../../src/registry/backups.js";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { getProjectByRef } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { signInToRegistry } from "../helpers/session.js";

vi.mock("../../src/boxes/admin-client.js", async (importOriginal) => {
  const fakeAdmin: AdminClientRunner = async (_conn, run) =>
    run({ query: async () => ({ rowCount: 0, rows: [] }) } as unknown as pg.Client);
  return {
    ...(await importOriginal<typeof import("../../src/boxes/admin-client.js")>()),
    withAdminClient: fakeAdmin,
  };
});

vi.mock("../../src/projects/pooler.js", () => ({ refreshSharedPooler: async () => {} }));

vi.mock("../../src/backups/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/s3.js")>()),
  uploadStream: async () => {},
  downloadBackupObject: async () => {},
}));

vi.mock("../../src/backups/pg-dump.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/pg-dump.js")>()),
  startDump: () => ({
    stream: Readable.from([]),
    bytes: () => 1_258_291,
    exited: Promise.resolve(0),
  }),
}));

vi.mock("../../src/backups/pg-restore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/pg-restore.js")>()),
  writeRestoreList: async () => {},
  restoreArchive: async () => {},
}));

const ORIGIN = "http://hattisar.test";
const HTTP_WARNING = "warning: http sends the token unencrypted\n";
const SECRET = "s".repeat(32);
const secretKey = deriveSecretKey(SECRET);

let dataDir: string;
let configDir: string;
let db: Registry;
let app: ReturnType<typeof createApp>;
let token: string;
let directBoxId: number;

function box(name: string, kind: "shared" | "registered", pooler: boolean) {
  return insertBox(db, {
    name,
    kind,
    devOnly: true,
    host: name,
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: encryptSecret("box-admin-secret", secretKey),
    sslmode: "disable",
    publicHost: `${name}.test`,
    publicPort: 54322,
    poolerTenant: pooler ? "hattisar" : null,
    poolerSessionPort: pooler ? 54322 : null,
    poolerTransactionPort: pooler ? 6543 : null,
    containerName: null,
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-cli-"));
  configDir = join(dataDir, "config", "hattisar");
  db = openRegistry(dataDir);
  signInToRegistry(db);
  const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number };
  const created = createApiToken(db, user.id, "cli", 30);
  if (!created.ok) throw new Error(created.problem);
  token = created.token;
  box("shared", "shared", true);
  directBoxId = box("direct", "registered", false).id;
  app = createApp(
    loadConfig({
      HATTISAR_SECRET_KEY: SECRET,
      HATTISAR_DATA_DIR: dataDir,
      PG_META_CRYPTO_KEY: "unit-test-crypto-key",
      POSTGRES_PASSWORD: "unused",
      POOLER_TENANT_ID: "hattisar",
      POOLER_JWT_SECRET: "pooler-jwt-secret",
      STUDIO_URL: "http://127.0.0.1:9",
    }),
    db,
  );
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface CliOptions {
  stdin?: string;
  env?: Record<string, string>;
  fetch?: Io["fetch"];
}

async function cli(argv: string[], options: CliOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    fetch: options.fetch ?? ((request) => Promise.resolve(app.request(request))),
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: { write: (text: string) => stderr.push(text) },
    stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    env: options.env ?? {},
    configDir,
  });
  const result = { code, stdout: stdout.join(""), stderr: stderr.join("") };
  expect(result.stdout + result.stderr).not.toContain(token);
  return result;
}

const noRequests: Io["fetch"] = () => {
  throw new Error("sent a request it should not have");
};

const login = () => cli(["login", `${ORIGIN}/`], { stdin: `${token}\n` });

async function loggedInWithProject(ref = "my-app", extra: string[] = []) {
  await login();
  const created = await cli(["projects", "create", "My App", "--ref", ref, ...extra]);
  expect(created).toMatchObject({ code: 0, stderr: "" });
}

describe("login", () => {
  it("checks a piped token and saves it 0600 in a 0700 directory", async () => {
    expect(await login()).toEqual({
      code: 0,
      stdout: `Logged in to ${ORIGIN} as admin\n`,
      stderr: HTTP_WARNING,
    });
    const file = join(configDir, "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: ORIGIN, token });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(await cli(["whoami"])).toMatchObject({ code: 0, stdout: `admin at ${ORIGIN}\n` });
  });

  it("exits 3 for a bad token without writing the config", async () => {
    const result = await cli(["login", ORIGIN], { stdin: `hs_${"x".repeat(43)}` });
    expect(result).toEqual({
      code: 3,
      stdout: "",
      stderr: `${HTTP_WARNING}hattisar: Missing or invalid API token\n`,
    });
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  it("refuses a URL that is not http or https", async () => {
    const result = await cli(["login", "ftp://hattisar.test"], { stdin: token });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("hattisar: the URL must be http or https\n");
  });

  it.each([
    ["http://admin:hunter2@hattisar.test", "the URL must not contain credentials"],
    ["http://admin@hattisar.test", "the URL must not contain credentials"],
    ["http://hattisar.test/?next=1", "the URL must not contain a query or fragment"],
    ["http://hattisar.test/#top", "the URL must not contain a query or fragment"],
    ["not a url hunter2", "the URL is not valid"],
  ])("refuses %s without echoing it", async (url, message) => {
    const result = await cli(["login", url], { stdin: token });
    expect(result).toMatchObject({ code: 2, stdout: "" });
    expect(result.stderr).toContain(`hattisar: ${message}\n`);
    expect(result.stderr).not.toContain("hunter2");
    expect(result.stderr).not.toContain("admin");
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  it("tightens an existing looser directory and file", async () => {
    mkdirSync(configDir, { recursive: true });
    chmodSync(configDir, 0o755);
    const file = join(configDir, "config.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o644);
    expect(await login()).toMatchObject({ code: 0 });
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: ORIGIN, token });
  });

  it("reports a config it cannot write in one line", async () => {
    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(configDir, "not a directory");
    const result = await cli(["login", ORIGIN], { stdin: token });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /^warning: .*\nhattisar: cannot write \S+config\.json: E[A-Z]+\n$/,
    );
  });

  it("reports a server that does not answer JSON", async () => {
    const result = await cli(["login", ORIGIN], {
      stdin: token,
      fetch: async () => new Response("<html>hello</html>", { status: 200 }),
    });
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `${HTTP_WARNING}hattisar: unexpected response from ${ORIGIN}\n`,
    });
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  it.each([
    ["a second line", (t: string) => `${t}\nsecond\n`],
    ["a carriage return", (t: string) => `${t}\rx`],
    ["no hs_ prefix", (t: string) => t.slice(3)],
  ])("refuses a token with %s without sending or echoing it", async (_, mangle) => {
    const result = await cli(["login", "http://127.0.0.1:9"], {
      stdin: mangle(token),
      fetch: noRequests,
    });
    expect(result).toEqual({ code: 3, stdout: "", stderr: "hattisar: the token is not valid\n" });
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  it("trims whitespace around a pasted token", async () => {
    expect(await cli(["login", ORIGIN], { stdin: `  ${token} \r\n` })).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))).toEqual({
      url: ORIGIN,
      token,
    });
  });

  it.each([
    ["http://hattisar.test", true],
    ["https://hattisar.test", false],
    ["http://localhost:8000", false],
    ["http://127.0.0.1:8000", false],
    ["http://[::1]:8000", false],
  ])("warns that %s sends the token unencrypted: %s", async (url, warns) => {
    const me: Io["fetch"] = async () => Response.json({ username: "admin" });
    const result = await cli(["login", url], { stdin: token, fetch: me });
    expect(result).toEqual({
      code: 0,
      stdout: `Logged in to ${url} as admin\n`,
      stderr: warns ? HTTP_WARNING : "",
    });
  });

  it("refuses a server that redirects, naming where to log in instead", async () => {
    const requests: Request[] = [];
    const redirecting: Io["fetch"] = async (request) => {
      requests.push(request);
      return new Response(null, {
        status: 301,
        headers: { location: "https://user:pw@hattisar.test/_hs/api/v1/me?next=1#x" },
      });
    };
    const result = await cli(["login", ORIGIN], { stdin: token, fetch: redirecting });
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `${HTTP_WARNING}hattisar: ${ORIGIN} redirected to https://hattisar.test — log in with that URL instead\n`,
    });
    expect(requests.map((request) => request.redirect)).toEqual(["manual"]);
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  it("forgets the config on logout, and logging out twice is fine", async () => {
    await login();
    expect(await cli(["logout"])).toMatchObject({ code: 0, stdout: "Logged out\n" });
    expect(await cli(["logout"])).toMatchObject({ code: 0 });
    expect(await cli(["whoami"])).toEqual({
      code: 3,
      stdout: "",
      stderr: "hattisar: not logged in — run hattisar login <url>\n",
    });
  });
});

describe("credentials from the environment", () => {
  it("lets HATTISAR_TOKEN and HATTISAR_URL override the config", async () => {
    await login();
    const env = { HATTISAR_URL: ORIGIN, HATTISAR_TOKEN: `hs_${"x".repeat(43)}` };
    expect(await cli(["whoami"], { env })).toMatchObject({ code: 3 });
    expect(await cli(["logout"])).toMatchObject({ code: 0 });
    expect(await cli(["whoami"], { env: { ...env, HATTISAR_TOKEN: token } })).toMatchObject({
      code: 0,
      stdout: `admin at ${ORIGIN}\n`,
    });
  });

  it("never sends the saved token to another HATTISAR_URL", async () => {
    await login();
    let requests = 0;
    const counting: Io["fetch"] = async () => {
      requests += 1;
      return new Response("{}");
    };
    const elsewhere = "http://elsewhere.test";
    expect(
      await cli(["whoami"], { env: { HATTISAR_URL: `${elsewhere}/` }, fetch: counting }),
    ).toEqual({ code: 3, stdout: "", stderr: `hattisar: not logged in to ${elsewhere}\n` });
    expect(requests).toBe(0);
    expect(await cli(["whoami"], { env: { HATTISAR_URL: `${ORIGIN}/` } })).toMatchObject({
      code: 0,
      stdout: `admin at ${ORIGIN}\n`,
    });
  });

  it.each([
    ["HATTISAR_TOKEN", () => ({ HATTISAR_URL: ORIGIN, HATTISAR_TOKEN: `${token}\nsecond` })],
    [
      "the saved config",
      () => {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
          join(configDir, "config.json"),
          JSON.stringify({ url: ORIGIN, token: `${token}\nx` }),
        );
        return {};
      },
    ],
  ])("refuses a malformed token from %s without sending or echoing it", async (_, setup) => {
    expect(await cli(["whoami"], { env: setup(), fetch: noRequests })).toEqual({
      code: 3,
      stdout: "",
      stderr: "hattisar: the token is not valid\n",
    });
  });

  it("refuses a HATTISAR_URL with credentials", async () => {
    const result = await cli(["whoami"], {
      env: { HATTISAR_URL: "http://admin:hunter2@hattisar.test", HATTISAR_TOKEN: token },
    });
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "hattisar: the URL must not contain credentials\n",
    });
  });
});

describe("projects", () => {
  it("creates, lists, shows and prints the URL of a project", async () => {
    await login();
    expect(await cli(["projects", "create", "My App"])).toEqual({
      code: 0,
      stdout: "Created my-app on shared\n",
      stderr: "",
    });
    const listed = await cli(["projects", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(
      /^REF {5}NAME {4}BOX {5}CREATED\nmy-app {2}My App {2}shared {2}\d{4}-\d\d-\d\d \d\d:\d\d UTC\n$/,
    );

    const shown = await cli(["projects", "show", "my-app"]);
    expect(shown.stdout).toContain(
      "Session pooler      postgresql://hs_my_app_owner.hattisar:••••••••@",
    );

    const url = await cli(["projects", "url", "my-app"]);
    expect(url.code).toBe(0);
    expect(url.stdout).toMatch(
      /^postgresql:\/\/hs_my_app_owner\.hattisar:[^@•]{8,}@shared\.test:54322\/my_app\n$/,
    );
    const transaction = await cli(["projects", "url", "my-app", "--transaction"]);
    expect(transaction.stdout).toContain("@shared.test:6543/my_app");
  });

  it("prints the API's JSON with --json", async () => {
    await loggedInWithProject();
    const listed = await cli(["projects", "list", "--json"]);
    const projects = JSON.parse(listed.stdout) as Record<string, unknown>[];
    expect(projects).toEqual([
      expect.objectContaining({ ref: "my-app", name: "My App", status: "active" }),
    ]);
    const url = JSON.parse((await cli(["--json", "projects", "url", "my-app"])).stdout);
    expect(url).toMatchObject({ label: "Session pooler", kind: "session" });
  });

  it("fails --transaction on a box without a transaction pooler", async () => {
    await loggedInWithProject("plain", ["--box", String(directBoxId)]);
    expect(await cli(["projects", "url", "plain"])).toMatchObject({ code: 0 });
    expect(await cli(["projects", "url", "plain", "--transaction"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "hattisar: plain has no transaction pooler\n",
    });
  });

  it("deletes only with --confirm set to the ref, then restores from the trash", async () => {
    await loggedInWithProject();
    const missing = await cli(["projects", "delete", "my-app"]);
    expect(missing).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "hattisar: projects delete needs --confirm <ref>\n" +
        "usage: hattisar projects delete <ref> --confirm <ref>\n",
    });
    expect(await cli(["projects", "delete", "my-app", "--confirm", "other"])).toEqual({
      code: 2,
      stdout: "",
      stderr: "hattisar: --confirm must be the ref my-app\n",
    });
    expect(getProjectByRef(db, "my-app")?.status).toBe("active");

    expect(await cli(["projects", "delete", "my-app", "--confirm", "my-app"])).toEqual({
      code: 0,
      stdout: "Moved my-app to the trash\n",
      stderr: "",
    });
    expect((await cli(["projects", "list"])).stdout).toBe("No active projects\n");
    expect((await cli(["projects", "list", "--deleted"])).stdout).toContain("DELETED");
    expect(await cli(["projects", "restore", "my-app"])).toMatchObject({
      code: 0,
      stdout: "Restored my-app from the trash\n",
    });
  });

  it("rotates the owner password", async () => {
    await loggedInWithProject();
    const before = (await cli(["projects", "url", "my-app"])).stdout;
    expect(await cli(["projects", "rotate", "my-app"])).toMatchObject({
      code: 0,
      stdout: "Rotated the owner password of my-app\n",
    });
    expect((await cli(["projects", "url", "my-app"])).stdout).not.toBe(before);
  });

  it("prints the API's problems and exits 1", async () => {
    await login();
    const result = await cli(["projects", "create", "x", "--ref", "Bad Ref!"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^hattisar: Invalid request\n( {2}- .+\n)+$/);
  });

  it("exits 1 with the API's message for an unknown project", async () => {
    await login();
    expect(await cli(["projects", "show", "nope"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "hattisar: Not found\n",
    });
  });
});

describe("backups", () => {
  it("runs, lists and restores a backup", async () => {
    await loggedInWithProject();
    saveS3Settings(db, secretKey, {
      endpoint: undefined,
      region: "us-east-1",
      bucket: "team-backups",
      accessKeyId: "id",
      secretAccessKey: "secret",
      forcePathStyle: false,
      prefix: "hattisar",
    });
    const ran = await cli(["backups", "run", "my-app"]);
    expect(ran).toMatchObject({ code: 0, stderr: "" });
    const id = /^Backup (\d+) of my-app done \(1\.2 MB\)\n$/.exec(ran.stdout)?.[1];
    expect(getBackup(db, Number(id))?.status).toBe("done");

    const listed = await cli(["backups", "list", "my-app"]);
    expect(listed.stdout).toMatch(
      new RegExp(
        `^ID {2}KIND {4}STATUS  SIZE {4}CREATED +ERROR\n${id} +manual  done {4}1\\.2 MB  `,
      ),
    );
    expect(JSON.parse((await cli(["backups", "list", "my-app", "--json"])).stdout)).toHaveLength(1);

    expect(await cli(["backups", "restore", "my-app", String(id)])).toMatchObject({ code: 2 });
    expect(await cli(["backups", "restore", "my-app", String(id), "--confirm", "my-app"])).toEqual({
      code: 0,
      stdout: `Restored backup ${id} into my-app\n`,
      stderr: "",
    });
  });
});

describe("boxes", () => {
  it("lists boxes", async () => {
    await login();
    expect((await cli(["boxes", "list"])).stdout).toBe(
      [
        "ID  NAME    KIND        ADDRESS            DEV ONLY",
        "2   direct  registered  direct.test:54322  yes",
        "1   shared  shared      shared.test:54322  yes",
        "",
      ].join("\n"),
    );
  });
});

describe("usage", () => {
  const CREDENTIALS = { HATTISAR_URL: ORIGIN, HATTISAR_TOKEN: "hs_unused" };

  it.each([
    [[], "hattisar: missing command"],
    [["frob"], "hattisar: unknown command frob"],
    [["projects"], "hattisar: missing command"],
    [["projects", "show"], "hattisar: missing <ref>"],
    [["projects", "show", "a", "b"], "hattisar: unexpected argument b"],
    [["projects", "list", "--transaction"], "hattisar: unknown option --transaction"],
    [["projects", "delete", "a"], "hattisar: projects delete needs --confirm <ref>"],
    [["backups", "restore", "a", "1"], "hattisar: backups restore needs --confirm <ref>"],
    [["projects", "delete", "a", "--confirm"], "hattisar: --confirm needs a value"],
    [["projects", "list", "--json=foo"], "hattisar: --json takes no value"],
    [["projects", "list", "--deleted=x"], "hattisar: --deleted takes no value"],
    [["projects", "create", "a", "--box", "1", "--new-box"], "hattisar: give either --box"],
    [["backups", "restore", "a", "b", "--confirm", "a"], "hattisar: b is not a backup id"],
  ])("exits 2 for %j without a request", async (argv, message) => {
    const result = await cli(argv, { env: CREDENTIALS, fetch: noRequests });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.startsWith(message)).toBe(true);
    expect(result.stderr).toContain("usage: hattisar");
  });

  it.each([
    [["projects", "delete", "a", "--confirm", "b"], "hattisar: --confirm must be the ref a\n"],
    [["backups", "restore", "a", "1", "--confirm", "b"], "hattisar: --confirm must be the ref a\n"],
  ])("exits 2 for %j without a request", async (argv, stderr) => {
    expect(await cli(argv, { env: CREDENTIALS, fetch: noRequests })).toEqual({
      code: 2,
      stdout: "",
      stderr,
    });
  });

  it("prints help and the version on stdout", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("projects url <ref> [--transaction]");
    expect(await cli(["projects", "url", "--help"])).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^usage: hattisar projects url <ref> \[--transaction\]\n/),
    });
    const { version } = JSON.parse(readFileSync("cli/package.json", "utf8")) as { version: string };
    expect(await cli(["--version"])).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
  });

  it("reports a server it cannot reach and exits 1", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
    });
    const result = await cli(["whoami"], {
      env: { HATTISAR_URL: "http://127.0.0.1:9", HATTISAR_TOKEN: token },
      fetch: () => Promise.reject(refused),
    });
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "hattisar: cannot reach http://127.0.0.1:9: ECONNREFUSED\n",
    });
  });

  it("never repeats what the request layer says, since it can quote the token", async () => {
    const result = await cli(["whoami"], {
      env: { HATTISAR_URL: ORIGIN, HATTISAR_TOKEN: token },
      fetch: () => Promise.reject(new TypeError(`invalid header value "Bearer ${token}"`)),
    });
    expect(result).toEqual({ code: 1, stdout: "", stderr: `hattisar: cannot reach ${ORIGIN}\n` });
  });
});
