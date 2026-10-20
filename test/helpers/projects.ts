import { registrySql, sharedBoxSql, startTestStack } from "../stack.js";
import { postForm, signIn } from "./session.js";

export const ROUTING_PROJECTS = [
  { ref: "spike-a", name: "Spike A", table: "alpha" },
  { ref: "spike-b", name: "Spike B", table: "beta" },
] as const;

export function fetchWith(baseUrl: string, cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
}

export async function sharedBoxId(baseUrl: string, cookie: string): Promise<string> {
  const html = await (await fetchWith(baseUrl, cookie, "/_hs/projects/new")).text();
  const id = /<option value="(\d+)" selected="">shared\b/.exec(html)?.[1];
  if (!id) throw new Error("the new-project form does not preselect the shared box");
  return id;
}

export async function createProject(
  baseUrl: string,
  cookie: string,
  fields: { ref: string; name: string; boxId: string },
): Promise<Response> {
  return postForm(baseUrl, "/_hs/projects", fields, cookie);
}

export function postQuery(baseUrl: string, cookie: string, ref: string, query: string) {
  return fetchWith(baseUrl, cookie, `/api/platform/pg-meta/${ref}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

// The connection strings as the project page offers them behind Reveal/Copy.
export async function connectionStrings(
  baseUrl: string,
  cookie: string,
  ref: string,
): Promise<string[]> {
  const html = await (await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}`)).text();
  return [...html.matchAll(/data-url="([^"]+)"/g)].map((match) => match[1] as string);
}

// Removes a project a test left behind, active or soft-deleted, without going through hattisar.
export function dropProject(ref: string): void {
  const db = ref.replaceAll("-", "_");
  sharedBoxSql(
    `SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database
      WHERE datname = :'db' OR starts_with(datname, :'db' || '__deleted_') \\gexec
     DROP ROLE IF EXISTS :"role";`,
    { db, role: `hs_${db}_owner` },
  );
  registrySql("DELETE FROM projects WHERE ref = ?", ref);
}

// Two projects on the shared box, created through hattisar: spike-a (table alpha), spike-b (beta).
export async function prepareRoutingProjects(baseUrl: string): Promise<void> {
  startTestStack();
  const cookie = await signIn(baseUrl);
  const boxId = await sharedBoxId(baseUrl, cookie);
  for (const { ref, name, table } of ROUTING_PROJECTS) {
    const exists = (await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}`)).status === 200;
    if (!exists) {
      const response = await createProject(baseUrl, cookie, { ref, name, boxId });
      if (response.status !== 302) {
        throw new Error(`creating ${ref} failed with ${response.status}: ${await response.text()}`);
      }
    }
    const created = await postQuery(
      baseUrl,
      cookie,
      ref,
      `create table if not exists public.${table} (id int primary key)`,
    );
    if (created.status !== 200) throw new Error(`creating ${ref}.${table} failed`);
  }
}
