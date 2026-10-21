export type Route =
  | { kind: "hattisar-public" }
  | { kind: "hattisar" }
  | { kind: "hattisar-api" }
  | { kind: "redirect"; location: string }
  | { kind: "ai-disabled" }
  | { kind: "not-available" }
  | { kind: "project-databases"; ref: string }
  | { kind: "project-settings"; ref: string }
  | { kind: "project-types"; ref: string }
  | { kind: "run-lints"; ref: string }
  | { kind: "platform-projects" }
  | { kind: "platform-project"; ref: string }
  | { kind: "project-api-pass"; ref: string }
  | { kind: "pg-meta-query"; ref: string }
  | { kind: "pg-meta"; ref: string }
  | { kind: "studio-project"; ref: string }
  | { kind: "not-found" }
  | { kind: "pass" };

const PROJECTS_PAGE = "/_hs/projects";
export const API_PREFIX = "/_hs/api";

// Matched case-insensitively and on the decoded path: Studio must never receive a pg-meta request
// hattisar did not recognise, however the client spells it. Anything under the prefix without a
// usable ref is a 404, not a pass-through.
const PG_META_PREFIX = /^\/api\/platform\/pg-meta(?:\/|$)/i;
const PG_META = /^\/api\/platform\/pg-meta\/([^/]+)(\/.*)?$/i;

export function classifyRequest(method: string, rawPath: string): Route {
  const path = decodePath(rawPath);
  // A leading // reads as a host to URL resolution; nothing legitimate is spelled that way.
  if (path === undefined || path.startsWith("//")) return { kind: "not-found" };

  if (PG_META_PREFIX.test(path)) {
    const match = PG_META.exec(path);
    if (!match?.[1]) return { kind: "not-found" };
    const ref = match[1];
    const isQuery = method === "POST" && match[2]?.toLowerCase() === "/query";
    return isQuery ? { kind: "pg-meta-query", ref } : { kind: "pg-meta", ref };
  }

  if (path === "/_hs/healthz" || path === "/_hs/login" || path.startsWith("/_hs/static/")) {
    return { kind: "hattisar-public" };
  }
  if (path === "/") return { kind: "redirect", location: PROJECTS_PAGE };
  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) return { kind: "hattisar-api" };
  if (path === "/_hs" || path.startsWith("/_hs/")) return { kind: "hattisar" };
  if (/^\/api\/ai(?:\/|$)/i.test(path)) return { kind: "ai-disabled" };

  if (path === "/api/platform/projects" && method === "GET") return { kind: "platform-projects" };

  // Any error status makes Studio retry for ~12 s before the Table Editor refreshes (§3).
  const lints = /^\/api\/platform\/projects\/([^/]+)\/run-lints$/.exec(path);
  if (lints?.[1] && method === "GET") return { kind: "run-lints", ref: lints[1] };

  // These query through Studio's own connection and cannot be pointed at a project.
  if (
    /^\/api\/platform\/projects\/[^/]+\/run-lints$/.test(path) ||
    /^\/api\/v1\/projects\/[^/]+\/database\/migrations$/.test(path) ||
    /^\/api\/mcp(?:\/|$)/.test(path)
  ) {
    return { kind: "not-available" };
  }

  const project = /^\/api\/(platform|v1)\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (project?.[2]) {
    const [, api, ref, rest] = project;
    if (method === "GET" && api === "platform" && rest === undefined) {
      return { kind: "platform-project", ref };
    }
    if (method === "GET" && api === "platform" && rest === "/databases") {
      return { kind: "project-databases", ref };
    }
    if (method === "GET" && api === "platform" && rest === "/settings") {
      return { kind: "project-settings", ref };
    }
    if (method === "GET" && api === "v1" && rest === "/types/typescript") {
      return { kind: "project-types", ref };
    }
    return { kind: "project-api-pass", ref };
  }

  const page = /^\/project\/([^/]+)(?:\/.*)?$/.exec(path);
  if (page?.[1]) return { kind: "studio-project", ref: page[1] };
  if (path === "/projects" || path === "/organizations" || /^\/org(?:\/|$)/.test(path)) {
    return { kind: "redirect", location: PROJECTS_PAGE };
  }
  if (/^\/new(?:\/|$)/.test(path)) return { kind: "redirect", location: `${PROJECTS_PAGE}/new` };

  return { kind: "pass" };
}

function decodePath(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}
