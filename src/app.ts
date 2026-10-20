import { Hono } from "hono";
import type { AuthEnv } from "./auth/middleware.js";
import { requireSameOrigin, requireSession } from "./auth/middleware.js";
import { LoginRateLimiter } from "./auth/rate-limit.js";
import { authRoutes } from "./auth/routes.js";
import { checkBox } from "./boxes/e1.js";
import { boxRoutes } from "./boxes/routes.js";
import type { Config } from "./config.js";
import type { Registry } from "./registry/db.js";
import { deriveSecretKey } from "./registry/secrets.js";
import { PgMetaLog } from "./studio/pg-meta.js";
import { SpikeProjectSource } from "./studio/projects-source.js";
import { STUDIO_CSS_PATH, STUDIO_JS_PATH } from "./studio/proxy.js";
import { createStudioHandler } from "./studio/studio-handler.js";
import { uiRoutes } from "./ui/routes.js";

export function createApp(config: Config, registry: Registry): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const pgMetaLog = new PgMetaLog();

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
  app.route(
    "/",
    boxRoutes({ db: registry, secretKey: deriveSecretKey(config.secretKey), check: checkBox }),
  );
  if (config.debug) {
    app.get("/_hs/debug/pg-meta-log", (c) => c.json(pgMetaLog.recent()));
  }

  app.all(
    "*",
    createStudioHandler({
      config,
      projects: new SpikeProjectSource(config.spikeProjects),
      pgMetaLog,
    }),
  );
  return app;
}
