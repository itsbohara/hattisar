import { type Context, Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import type { ManagedBoxes } from "../managed/service.js";
import { getBoxById, listBoxes } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { listProjectsOnBox } from "../registry/projects.js";
import { renderPage } from "../ui/layout.js";
import { BoxesPage, BoxFormPage } from "../ui/pages/boxes.js";
import {
  type BoxForm,
  type BoxServiceDeps,
  editableBox,
  editBox,
  formValues,
  type RemoveResult,
  registerBox,
  removeBox,
} from "./service.js";

const BOXES_PAGE = "/_hs/boxes";

function readForm(form: Record<string, unknown>): BoxForm {
  const text = (name: string) => {
    const value = form[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const password = form.adminPassword;
  return {
    name: text("name"),
    host: text("host"),
    port: text("port"),
    adminUser: text("adminUser"),
    adminPassword: typeof password === "string" ? password : "",
    sslmode: text("sslmode"),
    publicHost: text("publicHost"),
    publicPort: text("publicPort"),
    devOnly: form.devOnly !== undefined,
  };
}

function withoutPassword({ adminPassword: _, ...values }: BoxForm) {
  return values;
}

function boxRows(db: Registry) {
  return listBoxes(db).map((box) => ({
    box,
    projectCount: listProjectsOnBox(db, box.id).length,
  }));
}

function boxId(param: string): number {
  return /^\d+$/.test(param) ? Number(param) : Number.NaN;
}

// Only a tenant some box holds is echoed, so a crafted link cannot put its own text in the notice.
function resyncNotice(c: Context<AuthEnv>, db: Registry): string | undefined {
  const tenant = c.req.query("resynced");
  if (tenant === undefined || !listBoxes(db).some((box) => box.poolerTenant === tenant)) {
    return undefined;
  }
  return `Re-synced pooler tenant ${tenant}.`;
}

export function boxRoutes(deps: BoxServiceDeps & { managed?: ManagedBoxes }): Hono<AuthEnv> {
  const { db, managed, pooler } = deps;
  const app = new Hono<AuthEnv>();
  const managedEnabled = managed !== undefined;

  app.get(BOXES_PAGE, (c) =>
    renderPage(
      c,
      <BoxesPage rows={boxRows(db)} managedEnabled={managedEnabled} notice={resyncNotice(c, db)} />,
    ),
  );

  app.get("/_hs/boxes/new", (c) => renderPage(c, <BoxFormPage />));

  app.post(BOXES_PAGE, async (c) => {
    const form = readForm(await c.req.parseBody());
    const result = await registerBox(deps, form);
    if (result.ok) return c.redirect(BOXES_PAGE, 302);
    return renderPage(
      c,
      <BoxFormPage values={withoutPassword(form)} problems={result.problems} />,
      400,
    );
  });

  app.get("/_hs/boxes/:id/edit", (c) => {
    const box = editableBox(db, boxId(c.req.param("id")));
    if (!box) return c.notFound();
    return renderPage(c, <BoxFormPage boxId={box.id} values={formValues(box)} />);
  });

  app.post("/_hs/boxes/:id", async (c) => {
    const box = editableBox(db, boxId(c.req.param("id")));
    if (!box) return c.notFound();
    const form = readForm(await c.req.parseBody());
    const result = await editBox(deps, box, form);
    if (result.ok) return c.redirect(BOXES_PAGE, 302);
    return renderPage(
      c,
      <BoxFormPage boxId={box.id} values={withoutPassword(form)} problems={result.problems} />,
      400,
    );
  });

  app.post("/_hs/boxes/:id/remove", async (c) => {
    const box = getBoxById(db, boxId(c.req.param("id")));
    let result: RemoveResult;
    if (box?.kind === "registered") result = await removeBox(deps, box);
    else if (box?.kind === "managed" && managed) result = await managed.remove(box);
    else return c.notFound();
    if (result.ok) return c.redirect(BOXES_PAGE, 302);
    return renderPage(
      c,
      <BoxesPage rows={boxRows(db)} managedEnabled={managedEnabled} error={result.problem} />,
      409,
    );
  });

  app.post("/_hs/boxes/:id/pooler/resync", async (c) => {
    const box = getBoxById(db, boxId(c.req.param("id")));
    if (!box || box.kind === "shared") return c.notFound();
    const result = await pooler.resync(box);
    if (result.ok) {
      return c.redirect(`${BOXES_PAGE}?resynced=${encodeURIComponent(result.tenant)}`, 302);
    }
    if (result.reason === "not-found") return c.notFound();
    return renderPage(
      c,
      <BoxesPage rows={boxRows(db)} managedEnabled={managedEnabled} error={result.problem} />,
      result.reason === "refused" ? 400 : 502,
    );
  });

  return app;
}
