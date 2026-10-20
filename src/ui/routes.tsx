import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { APP_CSS_PATH } from "./layout.js";

// The build copies this directory next to the compiled routes.js (see the package.json build script).
const APP_CSS = readFileSync(new URL("./static/app.css", import.meta.url), "utf8");

export function uiRoutes(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get(APP_CSS_PATH, (c) => c.body(APP_CSS, 200, { "content-type": "text/css; charset=utf-8" }));

  return app;
}
