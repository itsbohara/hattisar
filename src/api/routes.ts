import { Hono } from "hono";
import type { BackupDeps } from "../backups/service.js";
import { type PoolerTenants, SHARED_BOX_POOLER } from "../pooler/tenants.js";
import { getBoxById, listBoxes } from "../registry/boxes.js";
import { type ApiEnv, requireApiToken } from "./auth.js";
import { backupApiRoutes } from "./backups.js";
import { apiError, badRequest, notFound } from "./errors.js";
import { type ProjectApiDeps, projectApiRoutes } from "./projects.js";

export type ApiDeps = ProjectApiDeps & { pooler: PoolerTenants };

// Mounted at API_PREFIX, not at /v1, so the catch-all answers every unknown /_hs/api/* path with
// JSON after the token check instead of letting it fall through to the HTML routes.
export function apiRoutes(deps: ApiDeps, backupDeps: BackupDeps): Hono<ApiEnv> {
  const { db, pooler } = deps;
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

  v1.post("/boxes/:id/pooler/resync", async (c) => {
    const id = c.req.param("id");
    const box = /^\d+$/.test(id) ? getBoxById(db, Number(id)) : undefined;
    if (!box) return notFound(c);
    if (box.kind === "shared") return badRequest(c, [SHARED_BOX_POOLER]);
    const result = await pooler.resync(box);
    if (result.ok) return c.json({ tenant: result.tenant });
    if (result.reason === "not-found") return notFound(c);
    if (result.reason === "refused") return badRequest(c, [result.problem]);
    return apiError(c, 502, result.problem);
  });

  v1.route("/projects", projectApiRoutes(deps));
  v1.route("/projects", backupApiRoutes(backupDeps, deps));

  app.route("/v1", v1);
  app.all("*", notFound);
  return app;
}
