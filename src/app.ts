import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { apiRoutes } from "./api/routes.js";
import type { AuthEnv } from "./auth/middleware.js";
import { requireSameOrigin, requireSession } from "./auth/middleware.js";
import { LoginRateLimiter } from "./auth/rate-limit.js";
import { authRoutes } from "./auth/routes.js";
import { backupRoutes } from "./backups/routes.js";
import type { BackupDeps } from "./backups/service.js";
import { withAdminClient } from "./boxes/admin-client.js";
import { checkBox } from "./boxes/e1.js";
import { boxRoutes } from "./boxes/routes.js";
import type { Config } from "./config.js";
import { managedLifecycle } from "./managed/lifecycle.js";
import { managedBoxRoutes } from "./managed/routes.js";
import type { ManagedBoxes } from "./managed/service.js";
import { refreshSharedPooler } from "./projects/pooler.js";
import { projectRoutes } from "./projects/routes.js";
import type { ProjectServiceDeps } from "./projects/service.js";
import { RegistryProjectSource } from "./projects/studio-source.js";
import { trashRoutes } from "./projects/trash-routes.js";
import type { Registry } from "./registry/db.js";
import { deriveSecretKey } from "./registry/secrets.js";
import { PgMetaLog } from "./studio/pg-meta.js";
import { API_PREFIX } from "./studio/routes.js";
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
export function projectServiceDeps(
  config: Config,
  registry: Registry,
  managed?: ManagedBoxes,
): ProjectServiceDeps {
  return {
    db: registry,
    secretKey: deriveSecretKey(config.secretKey),
    admin: withAdminClient,
    refreshPooler: refreshSharedPooler,
    onLifecycle: managed && managedLifecycle(registry, managed),
  };
}

// Shared by the HTTP routes and the scheduled-backups job in main.ts.
export function backupDeps(config: Config, registry: Registry): BackupDeps {
  return {
    db: registry,
    secretKey: deriveSecretKey(config.secretKey),
    pgBinDir: config.pgBinDir,
    dataDir: config.dataDir,
    backupHourUtc: config.backupHourUtc,
  };
}

// `managed` is present only when HATTISAR_MANAGED_BOXES is on (see createManagedBoxes).
export function createApp(
  config: Config,
  registry: Registry,
  managed?: ManagedBoxes,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const pgMetaLog = new PgMetaLog();
  const secretKey = deriveSecretKey(config.secretKey);

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const { pathname } = new URL(c.req.url);
    logUnexpected(c.req.method, pathname, error);
    return pathname.startsWith("/api/") || pathname.startsWith(`${API_PREFIX}/`)
      ? c.json(INTERNAL_ERROR_BODY, 500)
      : renderPage(c, ErrorPage(), 500);
  });

  app.get("/_hs/healthz", (c) => c.json({ ok: true }));
  app.use(requireSameOrigin());
  app.use(requireSession(registry));

  const projectDeps = projectServiceDeps(config, registry, managed);
  const backups = backupDeps(config, registry);
  app.route(API_PREFIX, apiRoutes({ ...projectDeps, managed }, backups));

  app.route(
    "/",
    authRoutes({
      db: registry,
      limiter: new LoginRateLimiter(),
      cookieSecure: config.cookieSecure,
    }),
  );
  app.route("/", uiRoutes());
  app.route("/", boxRoutes({ db: registry, secretKey, check: checkBox, managed }));
  if (managed) app.route("/", managedBoxRoutes(managed));
  app.route("/", projectRoutes({ ...projectDeps, backupHourUtc: config.backupHourUtc, managed }));
  app.route("/", trashRoutes({ ...projectDeps, purgeAfterDays: config.purgeAfterDays }));
  app.route("/", backupRoutes(backups, projectDeps));
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
