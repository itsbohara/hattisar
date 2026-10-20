import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { renderPage } from "../ui/layout.js";
import { ManagedBoxFormPage } from "../ui/pages/boxes.js";
import type { ManagedBoxes } from "./service.js";

// Mounted only when managed boxes are on; otherwise these paths are plain 404s.
export function managedBoxRoutes(managed: ManagedBoxes): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/_hs/managed-boxes/new", (c) => renderPage(c, <ManagedBoxFormPage />));

  app.post("/_hs/managed-boxes", async (c) => {
    const value = (await c.req.parseBody()).name;
    const name = typeof value === "string" ? value.trim() : "";
    const result = await managed.create(name);
    if (result.ok) return c.redirect("/_hs/boxes", 302);
    return renderPage(c, <ManagedBoxFormPage name={name} problems={result.problems} />, 400);
  });

  return app;
}
