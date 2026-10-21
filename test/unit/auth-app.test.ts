import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { loadConfig } from "../../src/config.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertUser } from "../../src/registry/users.js";
import { sessionCookie, signInToRegistry, tokenFrom } from "../helpers/session.js";

const ORIGIN = "http://hattisar.test";
const PASSWORD = "unit-admin-password";

let dataDir: string;
let db: Registry;
let app: ReturnType<typeof createApp>;

function build(env: Record<string, string> = {}) {
  return createApp(
    loadConfig({
      HATTISAR_SECRET_KEY: "s".repeat(32),
      PG_META_CRYPTO_KEY: "unit-test-crypto-key",
      POSTGRES_PASSWORD: "unused",
      POOLER_TENANT_ID: "hattisar",
      STUDIO_URL: "http://127.0.0.1:9",
      HATTISAR_DEBUG: "true",
      ...env,
    }),
    db,
  );
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-auth-app-"));
  db = openRegistry(dataDir);
  insertUser(db, { username: "admin", passwordHash: await hashPassword(PASSWORD) });
  app = build();
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function get(path: string, cookie?: string): Promise<Response> {
  return app.request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
}

async function post(
  path: string,
  fields: Record<string, string>,
  { cookie, origin = ORIGIN }: { cookie?: string; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin };
  if (cookie) headers.cookie = cookie;
  return app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
}

async function logIn(password = PASSWORD): Promise<Response> {
  return post("/_hs/login", { username: "admin", password });
}

describe("unauthenticated requests", () => {
  it.each([
    "/api/platform/projects",
    "/api/platform/pg-meta/spike-b/tables",
    "/api/v1/projects/spike-b/types/typescript",
  ])("answers API %s with 401 JSON", async (path) => {
    const response = await get(path);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: "Not signed in" } });
  });

  it.each([
    "/",
    "/_hs/projects",
    "/_hs/settings",
    "/_hs/debug/pg-meta-log",
    "/project/spike-b/editor",
    "/_next/static/chunk.js",
    "/_hs/static/../projects",
  ])("redirects page %s to the login page", async (path) => {
    const response = await get(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/login");
  });

  it("never treats a pg-meta path as public", async () => {
    const response = await get("/api/platform/pg-meta/_hs/static/x");
    expect(response.status).toBe(401);
  });

  it.each([
    ["/_hs/healthz", "application/json"],
    ["/_hs/login", "text/html"],
    ["/_hs/static/app.css", "text/css"],
    ["/_hs/static/studio.css", "text/css"],
    ["/_hs/static/studio.js", "text/javascript"],
  ])("serves %s without a session", async (path, type) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(type);
  });

  it.each(["/_hs/static/app.css", "/_hs/static/studio.css", "/_hs/static/studio.js"])(
    "makes browsers revalidate %s",
    async (path) => {
      expect((await get(path)).headers.get("cache-control")).toBe("no-cache");
    },
  );

  it.each(["/_hs/static/studio.css", "/_hs/static/studio.js"])(
    "serves a non-empty %s",
    async (path) => {
      expect((await (await get(path)).text()).length).toBeGreaterThan(0);
    },
  );
});

describe("login", () => {
  it("sets an HttpOnly, SameSite=Lax session cookie and redirects to projects", async () => {
    const response = await logIn();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/projects");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^hs_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(cookie).not.toContain("Secure");
  });

  it("marks the cookie Secure when HATTISAR_COOKIE_SECURE=true", async () => {
    app = build({ HATTISAR_COOKIE_SECURE: "true" });
    expect((await logIn()).headers.get("set-cookie")).toContain("Secure");
  });

  it("re-renders the form with an inline error on a wrong password", async () => {
    const response = await logIn("wrong-password!");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("Wrong username or password.");
  });

  it("answers 429 after five failures, even for the right password", async () => {
    for (let i = 0; i < 5; i++) expect((await logIn("wrong-password!")).status).toBe(401);
    expect((await logIn()).status).toBe(429);
  });

  it("refuses a cross-origin login with 403", async () => {
    const response = await post(
      "/_hs/login",
      { username: "admin", password: PASSWORD },
      { origin: "http://evil.test" },
    );
    expect(response.status).toBe(403);
  });

  it("sends a signed-in visitor from the login page to projects", async () => {
    const response = await get("/_hs/login", signInToRegistry(db));
    expect(response.headers.get("location")).toBe("/_hs/projects");
  });
});

describe("signed-in requests", () => {
  it("keeps hattisar's own pages out of the browser cache", async () => {
    const cookie = signInToRegistry(db);
    for (const path of ["/_hs/projects", "/_hs/settings/account", "/_hs/settings/storage"]) {
      expect((await get(path, cookie)).headers.get("cache-control")).toBe("no-store");
    }
  });

  it("renders the shell with the nav", async () => {
    const response = await get("/_hs/projects", signInToRegistry(db));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    for (const label of ["Projects", "Trash", "Boxes", "Settings", "Log out"]) {
      expect(html).toContain(label);
    }
  });

  it("shows the signed-in user in the account menu", async () => {
    const html = await (await get("/_hs/projects", signInToRegistry(db))).text();
    expect(html).toContain(
      '<summary class="avatar" aria-label="Account menu" title="admin">A</summary>',
    );
    expect(html).toContain('<input type="hidden" name="back" value="/_hs/projects"/>');
  });

  it("stores a chosen theme, renders it, and clears it for System", async () => {
    const cookie = signInToRegistry(db);
    const dark = await post("/_hs/theme", { theme: "dark", back: "/_hs/boxes" }, { cookie });
    expect(dark.status).toBe(303);
    expect(dark.headers.get("location")).toBe("/_hs/boxes");
    const themeCookie = (dark.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(themeCookie).toBe("hs_theme=dark");
    const html = await (await get("/_hs/projects", `${cookie}; ${themeCookie}`)).text();
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain('value="dark" class="menu-item menu-choice" aria-pressed="true"');

    const system = await post("/_hs/theme", { theme: "system", back: "/_hs/boxes" }, { cookie });
    expect(system.headers.get("set-cookie")).toMatch(/^hs_theme=; Max-Age=0/);
  });

  it.each(["https://evil.test/", "//evil.test/_hs/", "/project/x"])(
    "sends a theme change back to the projects page, not to %s",
    async (back) => {
      const response = await post(
        "/_hs/theme",
        { theme: "light", back },
        { cookie: signInToRegistry(db) },
      );
      expect(response.headers.get("location")).toBe("/_hs/projects");
    },
  );

  it("serves the debug log with a session", async () => {
    expect((await get("/_hs/debug/pg-meta-log", signInToRegistry(db))).status).toBe(200);
  });

  it.each(["/_hs/logout", "/%5Fhs/logout", "/api/platform/pg-meta/any/query", "/api/whatever"])(
    "refuses a state change to %s without a matching Origin or Referer",
    async (path) => {
      const response = await app.request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { cookie: signInToRegistry(db) },
      });
      expect(response.status).toBe(403);
    },
  );

  it("refuses a cross-origin text/plain POST that would run SQL", async () => {
    const response = await app.request(`${ORIGIN}/api/platform/pg-meta/any/query`, {
      method: "POST",
      headers: {
        cookie: signInToRegistry(db),
        origin: "http://evil.test",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ query: "drop schema public cascade" }),
    });
    expect(response.status).toBe(403);
  });

  it("logs out and ends the session", async () => {
    const cookie = signInToRegistry(db);
    const response = await post("/_hs/logout", {}, { cookie });
    expect(response.headers.get("location")).toBe("/_hs/login");
    expect((await get("/_hs/projects", cookie)).status).toBe(302);
  });
});

describe("change password", () => {
  async function change(cookie: string, fields: Partial<Record<string, string>> = {}) {
    return post(
      "/_hs/settings/password",
      { current: PASSWORD, password: "a-new-password", confirm: "a-new-password", ...fields },
      { cookie },
    );
  }

  it("keeps this session, ends the others and accepts only the new password", async () => {
    const current = sessionCookie(tokenFrom(await logIn()) ?? "");
    const other = sessionCookie(tokenFrom(await logIn()) ?? "");
    const response = await change(current);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Password changed.");
    expect((await get("/_hs/settings/account", current)).status).toBe(200);
    expect((await get("/_hs/settings/account", other)).status).toBe(302);
    expect((await logIn()).status).toBe(401);
    expect((await logIn("a-new-password")).status).toBe(302);
  });

  it.each([
    [{ current: "not-the-password" }, "Current password is wrong."],
    [{ password: "short", confirm: "short" }, "at least 12 characters"],
    [{ confirm: "something-else" }, "do not match"],
  ])("rejects %j inline", async (fields, message) => {
    const cookie = signInToRegistry(db);
    const response = await change(cookie, fields);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(message);
    expect((await logIn()).status).toBe(302);
  });
});
