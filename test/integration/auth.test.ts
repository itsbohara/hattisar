import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminCredentials, postForm, signIn } from "../helpers/session.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";

function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

function changePassword(cookie: string, current: string, next: string): Promise<Response> {
  return postForm(
    baseUrl,
    "/_hs/settings/password",
    { current, password: next, confirm: next },
    cookie,
  );
}

describe("auth in front of hattisar and Studio", () => {
  it("answers an unauthenticated projects API call with 401 JSON", async () => {
    const response = await get("/api/platform/projects");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: "Not signed in" } });
  });

  it.each(["/", "/project/spike-b/editor"])("redirects %s to the login page", async (path) => {
    const response = await get(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/login");
  });

  it("serves the login page and stylesheet without a session", async () => {
    expect((await get("/_hs/login")).status).toBe(200);
    expect((await get("/_hs/static/app.css")).headers.get("content-type")).toContain("text/css");
  });

  it("logs in and serves the projects API with the session cookie", async () => {
    const cookie = await signIn(baseUrl);
    const response = await get("/api/platform/projects", cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.any(Array));
  });

  it("refuses a cross-origin login", async () => {
    const response = await fetch(`${baseUrl}/_hs/login`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: "http://evil.test" },
      body: new URLSearchParams({ ...adminCredentials() }),
    });
    expect(response.status).toBe(403);
  });

  it("rate-limits a username after five failures", async () => {
    const username = `probe-${randomUUID()}`;
    const attempt = () => postForm(baseUrl, "/_hs/login", { username, password: "wrong" });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  it("logs out other sessions on password change", async () => {
    const { password } = adminCredentials();
    const temporary = `temporary-${randomUUID()}`;
    const current = await signIn(baseUrl);
    const other = await signIn(baseUrl);

    const changed = await changePassword(current, password, temporary);
    try {
      expect(changed.status).toBe(200);
      expect((await get("/api/platform/projects", other)).status).toBe(401);
      expect((await get("/api/platform/projects", current)).status).toBe(200);
    } finally {
      if (changed.status === 200) {
        expect((await changePassword(current, temporary, password)).status).toBe(200);
      }
    }
  });
});
