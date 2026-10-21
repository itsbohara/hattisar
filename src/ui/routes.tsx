import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AuthEnv } from "../auth/middleware.js";
import { STUDIO_CSS_PATH, STUDIO_JS_PATH } from "../studio/proxy.js";
import { APP_CSS_PATH, APP_JS_PATH, isTheme, THEME_COOKIE, THEME_PATH } from "./layout.js";

// The build copies this directory next to the compiled routes.js (see the package.json build script).
const readStatic = (name: string) =>
  readFileSync(new URL(`./static/${name}`, import.meta.url), "utf8");
const APP_CSS = readStatic("app.css");
const APP_JS = readStatic("app.js");
const STUDIO_CSS = readStatic("studio.css");
const STUDIO_JS = readStatic("studio.js");

// The paths never change between releases, so browsers must revalidate after a restart or upgrade.
const CSS = { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" };
const JS = { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" };

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

// Only hattisar's own pages: anything else would make this an open redirect.
function backTo(value: unknown): string {
  return typeof value === "string" && value.startsWith("/_hs/") ? value : "/_hs/projects";
}

export function uiRoutes(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get(APP_CSS_PATH, (c) => c.body(APP_CSS, 200, CSS));
  app.get(APP_JS_PATH, (c) => c.body(APP_JS, 200, JS));
  app.get(STUDIO_CSS_PATH, (c) => c.body(STUDIO_CSS, 200, CSS));
  app.get(STUDIO_JS_PATH, (c) => c.body(STUDIO_JS, 200, JS));

  app.post(THEME_PATH, async (c) => {
    const form = await c.req.parseBody();
    if (isTheme(form.theme)) {
      setCookie(c, THEME_COOKIE, form.theme, {
        path: "/_hs",
        sameSite: "Lax",
        maxAge: ONE_YEAR_SECONDS,
      });
    } else {
      deleteCookie(c, THEME_COOKIE, { path: "/_hs" });
    }
    return c.redirect(backTo(form.back), 303);
  });

  return app;
}
