import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { STUDIO_CSS_PATH, STUDIO_JS_PATH } from "../studio/proxy.js";
import { APP_CSS_PATH } from "./layout.js";

// The build copies this directory next to the compiled routes.js (see the package.json build script).
const readStatic = (name: string) =>
  readFileSync(new URL(`./static/${name}`, import.meta.url), "utf8");
const APP_CSS = readStatic("app.css");
const STUDIO_CSS = readStatic("studio.css");
const STUDIO_JS = readStatic("studio.js");

const CSS = { "content-type": "text/css; charset=utf-8" };
const JS = { "content-type": "text/javascript; charset=utf-8" };

export function uiRoutes(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get(APP_CSS_PATH, (c) => c.body(APP_CSS, 200, CSS));
  app.get(STUDIO_CSS_PATH, (c) => c.body(STUDIO_CSS, 200, CSS));
  app.get(STUDIO_JS_PATH, (c) => c.body(STUDIO_JS, 200, JS));

  return app;
}
