import type { Context } from "hono";
import type { Config } from "../config.js";
import { connectionHeaders, generateTypescriptTypes, type PgMetaLog, runQuery } from "./pg-meta.js";
import {
  AI_DISABLED_BODY,
  NOT_AVAILABLE_BODY,
  studioDatabases,
  studioProject,
  studioProjectDetail,
} from "./platform-routes.js";
import type { Project, ProjectSource } from "./projects-source.js";
import { proxyToStudio } from "./proxy.js";
import { classifyRequest } from "./routes.js";

export interface StudioDeps {
  config: Config;
  projects: ProjectSource;
  pgMetaLog: PgMetaLog;
}

const PROJECT_NOT_FOUND = { message: "Project not found" };

export function createStudioHandler({ config, projects, pgMetaLog }: StudioDeps) {
  // No auth yet: every request acts as the single admin.
  const user = config.adminUsername;

  function trace(c: Context, project: Project): void {
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

  return async (c: Context): Promise<Response> => {
    const route = classifyRequest(c.req.method, new URL(c.req.url).pathname);
    switch (route.kind) {
      case "hattisar-public":
      case "hattisar":
        return c.notFound();
      case "not-found":
        return c.json(PROJECT_NOT_FOUND, 404);
      case "redirect":
        return c.redirect(route.location, 302);
      case "ai-disabled":
        return c.json(AI_DISABLED_BODY, 404);
      case "not-available":
        return c.json(NOT_AVAILABLE_BODY, 404);
      case "platform-projects":
        return c.json((await projects.list(user)).map(studioProject));
      case "pass":
        return proxyToStudio(config.studioUrl, c.req.raw);
    }

    const project = await projects.get(user, route.ref);
    if (project === undefined) {
      return route.kind === "studio-project"
        ? c.redirect("/_hs/projects", 302)
        : c.json(PROJECT_NOT_FOUND, 404);
    }

    switch (route.kind) {
      case "platform-project":
        return c.json(studioProjectDetail(project));
      case "project-databases":
        // Spike: every project is on the shared box, published through the pooler's session port.
        return c.json(
          studioDatabases(project, { host: config.publicHost, port: config.pooler.portSession }),
        );
      case "project-types": {
        trace(c, project);
        const result = await generateTypescriptTypes(
          config.pgMetaUrl,
          project,
          config.pgMetaCryptoKey,
        );
        return Response.json(result.body, { status: result.status });
      }
      case "pg-meta-query": {
        trace(c, project);
        const body = await c.req.json().catch(() => undefined);
        const result = await runQuery(config.pgMetaUrl, project, config.pgMetaCryptoKey, body);
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
  };
}
