import { describe, expect, it } from "vitest";
import { classifyRequest } from "../../src/studio/routes.js";

describe("classifyRequest", () => {
  it.each([
    ["GET", "/_hs/healthz", { kind: "hattisar-public" }],
    ["GET", "/_hs/login", { kind: "hattisar-public" }],
    ["POST", "/_hs/login", { kind: "hattisar-public" }],
    ["GET", "/_hs/static/studio.css", { kind: "hattisar-public" }],
    ["GET", "/_hs/projects", { kind: "hattisar" }],
    ["GET", "/_hs/api", { kind: "hattisar-api" }],
    ["GET", "/_hs/api/v1/me", { kind: "hattisar-api" }],
    ["POST", "/_hs/api/v1/projects", { kind: "hattisar-api" }],
    ["GET", "/%5Fhs/api/v1/me", { kind: "hattisar-api" }],
    ["GET", "/_hs/apix", { kind: "hattisar" }],
    ["GET", "/", { kind: "redirect", location: "/_hs/projects" }],
    ["POST", "/api/ai/sql/generate-v4", { kind: "ai-disabled" }],
    ["POST", "/api/ai/code/complete", { kind: "ai-disabled" }],
    ["GET", "/api/ai", { kind: "ai-disabled" }],
    ["GET", "/api/platform/projects", { kind: "platform-projects" }],
    ["GET", "/api/platform/projects/spike-b", { kind: "platform-project", ref: "spike-b" }],
    ["PATCH", "/api/platform/projects/spike-b", { kind: "project-api-pass", ref: "spike-b" }],
    [
      "GET",
      "/api/platform/projects/spike-b/settings",
      { kind: "project-settings", ref: "spike-b" },
    ],
    [
      "PATCH",
      "/api/platform/projects/spike-b/settings",
      { kind: "project-api-pass", ref: "spike-b" },
    ],
    ["GET", "/api/v1/projects/spike-b/settings", { kind: "project-api-pass", ref: "spike-b" }],
    ["POST", "/api/platform/projects/spike-b/run-lints", { kind: "not-available" }],
    ["GET", "/api/platform/projects/spike-b/run-lints", { kind: "run-lints", ref: "spike-b" }],
    ["GET", "/api/v1/projects/spike-b/database/migrations", { kind: "not-available" }],
    ["POST", "/api/v1/projects/nope/database/migrations", { kind: "not-available" }],
    ["POST", "/api/mcp", { kind: "not-available" }],
    ["GET", "/api/mcp/sse", { kind: "not-available" }],
    ["GET", "/api/mcpx", { kind: "pass" }],
    [
      "GET",
      "/api/platform/projects/spike-b/databases",
      { kind: "project-databases", ref: "spike-b" },
    ],
    [
      "POST",
      "/api/platform/projects/spike-b/databases",
      { kind: "project-api-pass", ref: "spike-b" },
    ],
    ["GET", "/api/v1/projects/spike-b/types/typescript", { kind: "project-types", ref: "spike-b" }],
    [
      "POST",
      "/api/v1/projects/spike-b/types/typescript",
      { kind: "project-api-pass", ref: "spike-b" },
    ],
    ["GET", "/api/v1/projects/spike-b/api-keys", { kind: "project-api-pass", ref: "spike-b" }],
    [
      "GET",
      "/api/platform/projects/abc/content",
      { kind: "project-content", ref: "abc", rest: "" },
    ],
    [
      "PUT",
      "/api/platform/projects/abc/content",
      { kind: "project-content", ref: "abc", rest: "" },
    ],
    [
      "DELETE",
      "/api/platform/projects/abc/content",
      { kind: "project-content", ref: "abc", rest: "" },
    ],
    [
      "PATCH",
      "/api/platform/projects/abc/content",
      { kind: "project-content", ref: "abc", rest: "" },
    ],
    [
      "GET",
      "/api/platform/projects/abc/content/item/x",
      { kind: "project-content", ref: "abc", rest: "/item/x" },
    ],
    [
      "POST",
      "/api/platform/projects/abc/content/folders",
      { kind: "project-content", ref: "abc", rest: "/folders" },
    ],
    [
      "GET",
      "/api/platform/projects/abc/content/",
      { kind: "project-content", ref: "abc", rest: "/" },
    ],
    [
      "GET",
      "/api/platform/projects/abc/Content/count",
      { kind: "project-content", ref: "abc", rest: "/count" },
    ],
    [
      "GET",
      "/api/platform/projects/abc/%63ontent/count",
      { kind: "project-content", ref: "abc", rest: "/count" },
    ],
    ["GET", "/api/platform/projects/abc/contents", { kind: "project-api-pass", ref: "abc" }],
    ["GET", "/api/v1/projects/abc/content", { kind: "project-api-pass", ref: "abc" }],
    ["GET", "/api/v1/projects/spike-b", { kind: "project-api-pass", ref: "spike-b" }],
    ["POST", "/api/platform/pg-meta/spike-b/query", { kind: "pg-meta-query", ref: "spike-b" }],
    ["GET", "/api/platform/pg-meta/spike-b/query", { kind: "pg-meta", ref: "spike-b" }],
    ["GET", "/api/platform/pg-meta/spike-b/tables", { kind: "pg-meta", ref: "spike-b" }],
    ["POST", "/api/platform/pg-meta/spike-b/policies", { kind: "pg-meta", ref: "spike-b" }],
    ["GET", "/api/platform/pg-meta/spike-b", { kind: "pg-meta", ref: "spike-b" }],
    ["GET", "/project/default", { kind: "studio-project", ref: "default" }],
    ["GET", "/project/default/editor", { kind: "studio-project", ref: "default" }],
    ["GET", "/project/spike-b", { kind: "studio-project", ref: "spike-b" }],
    ["GET", "/project/spike-b/editor/17", { kind: "studio-project", ref: "spike-b" }],
    ["GET", "/projects", { kind: "redirect", location: "/_hs/projects" }],
    ["GET", "/organizations", { kind: "redirect", location: "/_hs/projects" }],
    ["GET", "/org/default/general", { kind: "redirect", location: "/_hs/projects" }],
    ["GET", "/new", { kind: "redirect", location: "/_hs/projects/new" }],
    ["GET", "/new/default", { kind: "redirect", location: "/_hs/projects/new" }],
    ["GET", "/_next/static/chunks/main.js", { kind: "pass" }],
    ["GET", "/api/platform/profile", { kind: "pass" }],
    ["GET", "/newsletter", { kind: "pass" }],
    ["GET", "/projectsx", { kind: "pass" }],
  ])("%s %s", (method, path, expected) => {
    expect(classifyRequest(method, path)).toEqual(expected);
  });

  it.each([
    "//evil.example/x",
    "//meta:8080/health",
    "/%2F%2Fevil/x",
    "/%2f/evil/x",
    "//_hs/static/studio.css",
    "//api/platform/projects",
  ])("answers a path starting with // (%s) with not-found", (path) => {
    expect(classifyRequest("GET", path)).toEqual({ kind: "not-found" });
  });

  describe("never lets a content path past hattisar's snippet handler", () => {
    it.each([
      ["/api/Platform/projects/abc/content", ""],
      ["/API/platform/projects/abc/content/count", "/count"],
      ["/api/platform/Projects/abc/CONTENT/item/x", "/item/x"],
      ["/api/platform/projects/abc//content", ""],
      ["/api//platform///projects/abc/content/folders", "/folders"],
      ["/api/platform/projects/abc/content//folders//x", "/folders/x"],
      ["/api/platform/projects/abc/%63ontent/count", "/count"],
    ])("%s", (path, rest) => {
      expect(classifyRequest("GET", path)).toEqual({ kind: "project-content", ref: "abc", rest });
    });

    it.each([
      "/api/platform/projects//content",
      "/api/platform/projects///content/count",
      "/API/Platform/Projects//Content",
    ])("answers %s without a ref with not-found", (path) => {
      expect(classifyRequest("PUT", path)).toEqual({ kind: "not-found" });
    });
  });

  describe("never lets a pg-meta path through without a ref", () => {
    it.each([
      "/api/platform/pg-meta",
      "/api/platform/pg-meta/",
      "/api/platform/pg-meta//tables",
      "/API/Platform/PG-META/spike-b/tables",
    ])("%s", (path) => {
      expect(classifyRequest("GET", path)).toMatchObject({
        kind: expect.stringMatching(/^(pg-meta|not-found)$/),
      });
    });

    it("rejects an empty ref", () => {
      expect(classifyRequest("GET", "/api/platform/pg-meta//tables")).toEqual({
        kind: "not-found",
      });
    });

    it("classifies a percent-encoded prefix by its decoded form", () => {
      expect(classifyRequest("GET", "/api/platform/pg%2Dmeta/spike-b/tables")).toEqual({
        kind: "pg-meta",
        ref: "spike-b",
      });
    });

    it("rejects a malformed percent-encoding", () => {
      expect(classifyRequest("GET", "/api/platform/pg-meta/%E0%A4%A/tables")).toEqual({
        kind: "not-found",
      });
    });
  });
});
