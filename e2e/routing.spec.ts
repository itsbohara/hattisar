import { expect, type Page, type Request, type Response, test } from "@playwright/test";
import { studioScreenPaths } from "./studio-screens.js";

const PROJECT = { ref: "spike-b", db: "spike_b", table: "beta" };
const OTHER_TABLE = "alpha";
const NO_PROJECT_DB = "hattisar_no_project";
const PG_META = /^\/api\/platform\/pg-meta\//;

interface PgMetaLogEntry {
  at: string;
  method: string;
  path: string;
  ref: string;
  db: string;
}

interface ApiCall {
  screen: string;
  method: string;
  path: string;
  status: number;
  body?: string;
}

async function readPgMetaLog(page: Page): Promise<PgMetaLogEntry[]> {
  const response = await page.request.get("/_hs/debug/pg-meta-log");
  expect(response.ok(), "HATTISAR_DEBUG must be on (test/compose.spike.yml)").toBe(true);
  return response.json();
}

function apiPattern({ method, path }: ApiCall): string {
  const pattern = path
    .replace(/^(\/api\/(?:platform|v1)\/(?:projects|pg-meta))\/[^/]+/, "$1/:ref")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
  return `${method} ${pattern}`;
}

test("every Studio screen for project B reads only B's database", async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  const calls: ApiCall[] = [];
  const pending: Promise<void>[] = [];
  const screenOf = new WeakMap<Request, string>();
  const pgMetaRequests: { screen: string; path: string }[] = [];
  let screen = "";

  page.on("request", (request) => {
    screenOf.set(request, screen);
    const { pathname } = new URL(request.url());
    if (PG_META.test(pathname)) pgMetaRequests.push({ screen, path: pathname });
  });
  page.on("response", (response: Response) => {
    const { pathname } = new URL(response.url());
    if (!pathname.startsWith("/api/")) return;
    const call: ApiCall = {
      screen: screenOf.get(response.request()) ?? screen,
      method: response.request().method(),
      path: pathname,
      status: response.status(),
    };
    calls.push(call);
    if (call.status >= 400) {
      pending.push(
        response.text().then(
          (body) => {
            call.body = body;
          },
          () => undefined,
        ),
      );
    }
  });

  const entries: PgMetaLogEntry[] = [];
  let since = (await readPgMetaLog(page)).at(-1)?.at ?? "";

  async function visit(path: string): Promise<void> {
    screen = path;
    const sentBefore = pgMetaRequests.length;
    const response = await page.goto(path);
    expect(response?.status(), `${path} is a Studio page`).toBe(200);
    await page.waitForLoadState("networkidle");

    // Read per screen so the bounded log never drops entries between reads.
    const fresh = (await readPgMetaLog(page)).filter((entry) => entry.at > since);
    since = fresh.at(-1)?.at ?? since;
    entries.push(...fresh);
    // Counted on requests: Studio cancels queries on navigation, and aborted ones still reach hattisar.
    expect(fresh.length, `${path}: every pg-meta request was resolved by hattisar`).toBe(
      pgMetaRequests.length - sentBefore,
    );
  }

  for (const path of studioScreenPaths(PROJECT.ref)) await visit(path);

  await visit(`/project/${PROJECT.ref}/editor`);
  await expect(page.getByText(PROJECT.table, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(OTHER_TABLE, { exact: true })).toHaveCount(0);

  await Promise.all(pending);
  const pgMetaCalls = calls.filter((call) => PG_META.test(call.path));
  const failures = calls.filter((call) => call.status >= 400);
  const inventory = [...new Set(calls.map(apiPattern))].sort();
  await testInfo.attach("api-inventory.json", {
    body: JSON.stringify({ inventory, failures, pgMetaRequests, pgMetaLog: entries }, null, 2),
    contentType: "application/json",
  });

  expect(pgMetaRequests.length).toBeGreaterThan(0);
  expect(entries.filter((entry) => entry.ref !== PROJECT.ref || entry.db !== PROJECT.db)).toEqual(
    [],
  );
  expect(pgMetaCalls.filter((call) => call.status >= 500)).toEqual([]);
  expect(pgMetaCalls.filter((call) => call.body?.includes(NO_PROJECT_DB))).toEqual([]);
});
