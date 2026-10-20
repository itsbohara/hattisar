import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthEnv } from "./auth/middleware.js";
import { requireSameOrigin, requireSession } from "./auth/middleware.js";
import { LoginRateLimiter } from "./auth/rate-limit.js";
import { authRoutes } from "./auth/routes.js";
import { withAdminClient } from "./boxes/admin-client.js";
import { checkBox } from "./boxes/e1.js";
import { boxRoutes } from "./boxes/routes.js";
import type { Config } from "./config.js";
import { refreshSharedPooler } from "./projects/pooler.js";
import { projectRoutes } from "./projects/routes.js";
import type { ProjectServiceDeps } from "./projects/service.js";
import { RegistryProjectSource } from "./projects/studio-source.js";
import { trashRoutes } from "./projects/trash-routes.js";
import type { Registry } from "./registry/db.js";
import { deriveSecretKey } from "./registry/secrets.js";
import { PgMetaLog } from "./studio/pg-meta.js";
import { STUDIO_CSS_PATH, STUDIO_JS_PATH } from "./studio/proxy.js";
import { createStudioHandler } from "./studio/studio-handler.js";
import { renderPage } from "./ui/layout.js";
import { ErrorPage } from "./ui/pages/error.js";
import { uiRoutes } from "./ui/routes.js";

const INTERNAL_ERROR_BODY = { error: { message: "Internal error" } };

// Logs the error's class and stack frames but not its message: a message can carry a value the
// failing code was handling, such as a decrypted secret or a request body.
function logUnexpected(method: string, path: string, error: Error): void {
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  console.error([`hattisar: ${error.name} on ${method} ${path}`, ...frames].join("\n"));
}

// Shared by the HTTP routes and the hourly purge job in main.ts.
export function projectServiceDeps(config: Config, registry: Registry): ProjectServiceDeps {
  return {
    db: registry,
    secretKey: deriveSecretKey(config.secretKey),
    admin: withAdminClient,
    refreshPooler: refreshSharedPooler,
  };
}

export function createApp(config: Config, registry: Registry): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const pgMetaLog = new PgMetaLog();
  const secretKey = deriveSecretKey(config.secretKey);

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const { pathname } = new URL(c.req.url);
    logUnexpected(c.req.method, pathname, error);
    return pathname.startsWith("/api/")
      ? c.json(INTERNAL_ERROR_BODY, 500)
      : renderPage(c, ErrorPage(), 500);
  });

  app.get("/_hs/healthz", (c) => c.json({ ok: true }));
  app.use(requireSameOrigin());
  app.use(requireSession(registry));

  app.get(STUDIO_CSS_PATH, (c) => c.body("", 200, { "content-type": "text/css; charset=utf-8" }));
  app.get(STUDIO_JS_PATH, (c) =>
    c.body("", 200, { "content-type": "text/javascript; charset=utf-8" }),
  );
  app.route(
    "/",
    authRoutes({
      db: registry,
      limiter: new LoginRateLimiter(),
      cookieSecure: config.cookieSecure,
    }),
  );
  app.route("/", uiRoutes());
  app.route("/", boxRoutes({ db: registry, secretKey, check: checkBox }));
  const projectDeps = projectServiceDeps(config, registry);
  app.route("/", projectRoutes(projectDeps));
  app.route("/", trashRoutes({ ...projectDeps, purgeAfterDays: config.purgeAfterDays }));
  if (config.debug) {
    app.get("/_hs/debug/pg-meta-log", (c) => c.json(pgMetaLog.recent()));
  }

  app.all(
    "*",
    createStudioHandler({
      config,
      projects: new RegistryProjectSource(registry, secretKey),
      pgMetaLog,
    }),
  );
  return app;
}
