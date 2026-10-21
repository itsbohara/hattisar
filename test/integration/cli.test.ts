import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../cli/src/run.js";
import { dropProject } from "../helpers/projects.js";
import { postForm, signIn } from "../helpers/session.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const suffix = randomUUID().slice(0, 8);
const ref = `it-cli-${suffix}`;
const tokenName = `it-cli-${suffix}`;
let cookie: string;
let configDir: string;
let token: string;
let tokenId: string | undefined;

async function cli(argv: string[], stdin = "") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    fetch: (request) => fetch(request),
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: { write: (text: string) => stderr.push(text) },
    stdin: Readable.from(stdin === "" ? [] : [stdin]),
    env: {},
    configDir,
  });
  const result = { code, stdout: stdout.join(""), stderr: stderr.join("") };
  expect(result.stdout + result.stderr).not.toContain(token);
  return result;
}

async function revokeToken(): Promise<void> {
  if (tokenId === undefined) return;
  const response = await postForm(baseUrl, `/_hs/settings/tokens/${tokenId}/revoke`, {}, cookie);
  expect(response.status).toBe(302);
  tokenId = undefined;
}

beforeAll(async () => {
  cookie = await signIn(baseUrl);
  configDir = mkdtempSync(join(tmpdir(), "hattisar-cli-it-"));
  const response = await postForm(
    baseUrl,
    "/_hs/settings/tokens",
    { name: tokenName, expiry: "30" },
    cookie,
  );
  const html = await response.text();
  if (response.status !== 201) throw new Error(`creating a token failed with ${response.status}`);
  tokenId = new RegExp(`<tr data-token="(\\d+)"><td>${tokenName}</td>`).exec(html)?.[1];
  const created = /<input readonly="" value="(hs_[^"]+)"/.exec(html)?.[1];
  if (!created || !tokenId) throw new Error("the token page did not show the new token");
  token = created;
}, 60_000);

afterAll(async () => {
  try {
    await revokeToken();
  } finally {
    dropProject(ref);
    rmSync(configDir, { recursive: true, force: true });
  }
});

describe("the CLI against the stack", () => {
  it("logs in, creates a project, connects with its URL and deletes it", async () => {
    expect(await cli(["login", baseUrl], `${token}\n`)).toMatchObject({ code: 0, stderr: "" });

    const created = await cli(["projects", "create", "CLI integration", "--ref", ref, "--json"]);
    expect(created).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(created.stdout)).toMatchObject({ ref, status: "active" });

    const url = await cli(["projects", "url", ref]);
    expect(url).toMatchObject({ code: 0, stderr: "" });
    const client = new pg.Client({
      connectionString: url.stdout.trim(),
      connectionTimeoutMillis: 10_000,
    });
    client.on("error", () => undefined);
    await client.connect();
    try {
      expect((await client.query("select 1 as ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }

    const deleted = await cli(["projects", "delete", ref, "--confirm", ref]);
    expect(deleted).toMatchObject({ code: 0, stdout: `Moved ${ref} to the trash\n` });
    const trash = await cli(["projects", "list", "--deleted", "--json"]);
    expect(JSON.parse(trash.stdout)).toContainEqual(expect.objectContaining({ ref }));
  });

  it("exits 3 once the token is revoked", async () => {
    expect((await cli(["whoami"])).code).toBe(0);
    await revokeToken();
    expect(await cli(["whoami"])).toEqual({
      code: 3,
      stdout: "",
      stderr: "hattisar: Missing or invalid API token\n",
    });
  });
});
