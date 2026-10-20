import { Hono } from "hono";
import type { Config } from "./config.js";

export function createApp(_config: Config): Hono {
  const app = new Hono();
  app.get("/_hs/healthz", (c) => c.json({ ok: true }));
  return app;
}
