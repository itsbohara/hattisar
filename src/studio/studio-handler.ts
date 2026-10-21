import type { Context } from "hono";
import { canAccess } from "../auth/access.js";
import type { AuthEnv } from "../auth/middleware.js";
import type { Config } from "../config.js";
import { connectionHeaders, generateTypescriptTypes, type PgMetaLog, runQuery } from "./pg-meta.js";
import {
  AI_DISABLED_BODY,
  NOT_AVAILABLE_BODY,
  SETTINGS_UNAVAILABLE_BODY,
  studioDatabases,
  studioProject,
  studioProjectDetail,
  studioSettings,
} from "./platform-routes.js";
import {
  type ProjectSource,
  type ProjectSummary,
  UnreadableSecretError,
} from "./projects-source.js";
import { proxyToStudio } from "./proxy.js";
import { classifyRequest } from "./routes.js";

export interface StudioDeps {
  config: Config;
  projects: ProjectSource;
  pgMetaLog: PgMetaLog;
}

const PROJECT_NOT_FOUND = { message: "Project not found" };

export function createStudioHandler({ config, projects, pgMetaLog }: StudioDeps) {
  const pgMetaTimeoutMs = config.pgMetaTimeoutSeconds * 1000;

  function trace(c: Context, project: ProjectSummary): void {
    if (!config.debug) return;
    const entry = {
      at: new Date().toISOString(),
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      ref: project.ref,
      box: project.boxName,
      db: project.dbName,
    };
    pgMetaLog.record(entry);
    console.debug(`pg-meta ${entry.method} ${entry.path} -> ${entry.box}/${entry.db}`);
  }

  return async (c: Context<AuthEnv>): Promise<Response> => {
    const route = classifyRequest(c.req.method, new URL(c.req.url).pathname);
    // requireSession lets public and token-API paths through without a session, so this check
    // comes first. A token-API path is never Studio's, even when the router missed it.
    if (
      route.kind === "hattisar-public" ||
      route.kind === "hattisar" ||
      route.kind === "hattisar-api"
    ) {
      return c.notFound();
    }
    const { user } = c.var.session;
    switch (route.kind) {
      case "not-found":
        return c.json(PROJECT_NOT_FOUND, 404);
      case "redirect":
        return c.redirect(route.location, 302);
      case "ai-disabled":
        return c.json(AI_DISABLED_BODY, 404);
      case "not-available":
        return c.json(NOT_AVAILABLE_BODY, 404);
      case "platform-projects":
        return c.json(
          (await projects.list(user.username))
            .filter((project) => canAccess(user, project))
            .map(studioProject),
        );
      case "pass":
        return proxyToStudio(config.studioUrl, c.req.raw);
    }

    const project = await projects.get(user.username, route.ref);
    if (project === undefined || !canAccess(user, project)) {
      return route.kind === "studio-project"
        ? c.redirect("/_hs/projects", 302)
        : c.json(PROJECT_NOT_FOUND, 404);
    }

    try {
      switch (route.kind) {
        case "platform-project":
          return c.json(studioProjectDetail(project));
        case "project-databases":
          return c.json(studioDatabases(project));
        case "project-settings": {
          // Never the stub as-is: it describes Studio's own default database.
          const upstream = await proxyToStudio(config.studioUrl, c.req.raw);
          const stub: unknown = upstream.ok
            ? await upstream.json().catch(() => undefined)
            : undefined;
          if (!isRecord(stub)) return c.json(SETTINGS_UNAVAILABLE_BODY, 502);
          return c.json(studioSettings(project, stub));
        }
        case "run-lints":
          return c.json([]);
        case "project-types": {
          trace(c, project);
          const result = await generateTypescriptTypes(
            config.pgMetaUrl,
            project,
            config.pgMetaCryptoKey,
            pgMetaTimeoutMs,
          );
          return Response.json(result.body, { status: result.status });
        }
        case "pg-meta-query": {
          trace(c, project);
          const body = await c.req.json().catch(() => undefined);
          const result = await runQuery(
            config.pgMetaUrl,
            project,
            config.pgMetaCryptoKey,
            body,
            pgMetaTimeoutMs,
          );
          return Response.json(result.body, { status: result.status });
        }
        case "pg-meta":
          trace(c, project);
          return proxyToStudio(
            config.studioUrl,
            c.req.raw,
            connectionHeaders(project, config.pgMetaCryptoKey),
          );
        case "project-api-pass":
        case "studio-project":
          return proxyToStudio(config.studioUrl, c.req.raw);
      }
    } catch (error) {
      if (error instanceof UnreadableSecretError) return c.json({ message: error.message }, 500);
      throw error;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
