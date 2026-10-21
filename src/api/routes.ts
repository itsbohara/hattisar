import { Hono } from "hono";
import { listBoxes } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { type ApiEnv, requireApiToken } from "./auth.js";
import { notFound } from "./errors.js";

export interface ApiDeps {
  db: Registry;
}

// Mounted at API_PREFIX, not at /v1, so the catch-all answers every unknown /_hs/api/* path with
// JSON after the token check instead of letting it fall through to the HTML routes.
export function apiRoutes(deps: ApiDeps): Hono<ApiEnv> {
  const { db } = deps;
  const app = new Hono<ApiEnv>();
  app.use(requireApiToken(db));
  const v1 = new Hono<ApiEnv>();

  v1.get("/me", (c) => c.json({ username: c.var.user.username }));

  v1.get("/boxes", (c) =>
    c.json(
      listBoxes(db).map(({ id, name, kind, devOnly, publicHost, publicPort }) => ({
        id,
        name,
        kind,
        devOnly,
        publicHost,
        publicPort,
      })),
    ),
  );

  app.route("/v1", v1);
  app.all("*", notFound);
  return app;
}
