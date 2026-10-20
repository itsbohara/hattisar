import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generateTypescriptTypes, runQuery } from "../../src/studio/pg-meta.js";
import type { Project } from "../../src/studio/projects-source.js";

const project = {
  dbName: "spike_b",
  ownerRole: "hs_spike_b_owner",
  ownerPassword: "secret",
  box: { host: "db", port: 5432, sslmode: "disable" },
} as Project;

const cryptoKey = "unit-test-crypto-key";
const TIMEOUT_MS = 100;

let server: Server | undefined;

async function listen(stall: "headers" | "body"): Promise<string> {
  server = createServer((_req, res) => {
    if (stall === "body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

async function timed<T>(run: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const started = performance.now();
  const result = await run();
  return { result, elapsedMs: performance.now() - started };
}

const timeoutMessage = "postgres-meta did not answer within 0.1 s";

describe.each(["headers", "body"] as const)("postgres-meta stalling on %s", (stall) => {
  it("answers runQuery with 504 in Studio's query error shape", async () => {
    const url = await listen(stall);
    const { result, elapsedMs } = await timed(() =>
      runQuery(url, project, cryptoKey, { query: "select 1" }, TIMEOUT_MS),
    );
    expect(result).toEqual({
      status: 504,
      body: { message: timeoutMessage, formattedError: timeoutMessage },
    });
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("answers generateTypescriptTypes with 504 in Studio's types error shape", async () => {
    const url = await listen(stall);
    const { result, elapsedMs } = await timed(() =>
      generateTypescriptTypes(url, project, cryptoKey, TIMEOUT_MS),
    );
    expect(result).toEqual({ status: 504, body: { message: timeoutMessage } });
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("postgres-meta unreachable", () => {
  it("keeps answering 500 for errors other than the timeout", async () => {
    const url = await listen("headers");
    server?.close();
    const query = await runQuery(url, project, cryptoKey, { query: "select 1" }, TIMEOUT_MS);
    const types = await generateTypescriptTypes(url, project, cryptoKey, TIMEOUT_MS);
    expect(query.status).toBe(500);
    expect(types.status).toBe(500);
  });
});
