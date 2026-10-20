import { Hono } from "hono";
import type { Config } from "./config.js";
import { PgMetaLog } from "./studio/pg-meta.js";
import { SpikeProjectSource } from "./studio/projects-source.js";
import { STUDIO_CSS_PATH, STUDIO_JS_PATH } from "./studio/proxy.js";
import { createStudioHandler } from "./studio/studio-handler.js";

export function createApp(config: Config): Hono {
  const app = new Hono();
  const pgMetaLog = new PgMetaLog();

  app.get("/_hs/healthz", (c) => c.json({ ok: true }));
  app.get(STUDIO_CSS_PATH, (c) => c.body("", 200, { "content-type": "text/css; charset=utf-8" }));
  app.get(STUDIO_JS_PATH, (c) =>
    c.body("", 200, { "content-type": "text/javascript; charset=utf-8" }),
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
