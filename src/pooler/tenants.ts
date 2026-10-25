import { randomBytes } from "node:crypto";
import { type AdminClientRunner, safeErrorMessage } from "../boxes/admin-client.js";
import { boxConnection } from "../boxes/service.js";
import { type Box, getBoxById, listBoxes, updateBox } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { dropPoolerRole, installPoolerRole, poolerRoleFor } from "./role.js";
import { assertTenantId, type TenantApi, type TenantInfo } from "./supavisor.js";
import { isPoolerEligible, tenantBody, tenantIdFor } from "./tenant-spec.js";

export interface PoolerTenants {
  ensure(box: Box): Promise<void>;
  drop(box: Box): Promise<void>;
  reconcile(): Promise<void>;
  resync(box: Box): Promise<ResyncResult>;
}

export type ResyncResult = { ok: true; tenant: string } | { ok: false; problem: string };

export interface PoolerTenantsDeps {
  db: Registry;
  secretKey: Buffer;
  api: TenantApi;
  admin: AdminClientRunner;
  tenantPrefix: string;
  portSession: number;
  portTransaction: number;
}

const NO_POOLER = { poolerTenant: null, poolerSessionPort: null, poolerTransactionPort: null };

function scrubbed(error: unknown, secrets: string[]): string {
  return secrets.reduce<string>(
    (message, secret) => safeErrorMessage(message, secret),
    safeErrorMessage(error, ""),
  );
}

export function createPoolerTenants(deps: PoolerTenantsDeps): PoolerTenants {
  const { db, api } = deps;
  const queues = new Map<number, Promise<unknown>>();

  // Every step re-reads the box inside its turn: a queued ensure must see the tenant the one
  // before it stored, or it would PUT again and drop the pools that PUT just created.
  function serialized<T>(id: number, step: () => Promise<T>): Promise<T> {
    const next = (queues.get(id) ?? Promise.resolve()).then(step);
    queues.set(id, next);
    void next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    });
    return next;
  }

  function warn(box: Box, action: string, error: unknown, ...secrets: string[]): void {
    console.warn(
      `hattisar: pooler tenant for box ${box.name} not ${action}: ${scrubbed(error, secrets)}`,
    );
  }

  // Returns the failure already scrubbed: only this function knows the generated password.
  async function create(box: Box, id: string): Promise<string | undefined> {
    const conn = boxConnection(box, deps.secretKey);
    const role = poolerRoleFor(deps.secretKey, id);
    const password = randomBytes(32).toString("base64url");
    try {
      assertTenantId(id);
      await deps.admin(conn, (client) => installPoolerRole(client, role, password), "postgres");
      await api.put(id, tenantBody(box, { role, password }), password);
    } catch (error) {
      return scrubbed(error, [password, conn.password]);
    }
    updateBox(db, box.id, {
      poolerTenant: id,
      poolerSessionPort: deps.portSession,
      poolerTransactionPort: deps.portTransaction,
    });
  }

  async function ensureStored(box: Box, id: string): Promise<void> {
    let tenant: TenantInfo | undefined;
    try {
      tenant = await api.get(id);
    } catch (error) {
      warn(box, "checked", error);
      return;
    }
    if (tenant?.dbHost === box.host && tenant.dbPort === box.port) return;
    // A moved box may be on another server, which has no role for this tenant yet.
    await createOrWarn(box, id);
  }

  async function createOrWarn(box: Box, id: string): Promise<void> {
    const problem = await create(box, id);
    if (problem !== undefined) warn(box, "created", problem);
  }

  // A managed box's role goes with its container and volume.
  async function dropRole(box: Box, id: string): Promise<void> {
    if (box.kind !== "registered") return;
    const conn = boxConnection(box, deps.secretKey);
    try {
      await deps.admin(
        conn,
        (client) => dropPoolerRole(client, poolerRoleFor(deps.secretKey, id)),
        "postgres",
      );
    } catch (error) {
      console.warn(
        `hattisar: pooler role for box ${box.name} not dropped: ${scrubbed(error, [conn.password])}`,
      );
    }
  }

  async function dropNow(box: Box): Promise<void> {
    if (box.poolerTenant === null) return;
    try {
      await api.remove(box.poolerTenant);
    } catch (error) {
      warn(box, "removed", error);
    }
    updateBox(db, box.id, NO_POOLER);
    await dropRole(box, box.poolerTenant);
  }

  async function ensureNow(box: Box): Promise<void> {
    if (box.kind === "shared") return;
    if (!isPoolerEligible(box)) return dropNow(box);
    if (box.poolerTenant !== null) return ensureStored(box, box.poolerTenant);
    await createOrWarn(box, newTenantId(box));
  }

  function newTenantId(box: Box): string {
    const taken = listBoxes(db).flatMap((other) =>
      other.id !== box.id && other.poolerTenant !== null ? [other.poolerTenant] : [],
    );
    return tenantIdFor(deps.tenantPrefix, box, taken);
  }

  function rewritePorts(box: Box): void {
    if (
      box.poolerTenant === null ||
      (box.poolerSessionPort === deps.portSession &&
        box.poolerTransactionPort === deps.portTransaction)
    ) {
      return;
    }
    updateBox(db, box.id, {
      poolerSessionPort: deps.portSession,
      poolerTransactionPort: deps.portTransaction,
    });
  }

  // No fallback to the caller's box: once the row is gone, a stale snapshot would recreate a
  // tenant (and role) that nothing ever drops.
  function ensureQueued(id: number, withPorts: boolean): Promise<void> {
    return serialized(id, async () => {
      const box = getBoxById(db, id);
      if (box === undefined) return;
      try {
        if (withPorts && box.kind !== "shared") rewritePorts(box);
        await ensureNow(box);
      } catch (error) {
        warn(box, "ensured", error);
      }
    });
  }

  function ensure(box: Box): Promise<void> {
    return ensureQueued(box.id, false);
  }

  // Falls back to the caller's box so drop works before or after deleteBox.
  function drop(box: Box): Promise<void> {
    return serialized(box.id, async () => {
      const current = getBoxById(db, box.id) ?? box;
      try {
        await dropNow(current);
      } catch (error) {
        warn(current, "removed", error);
      }
    });
  }

  async function reconcile(): Promise<void> {
    for (const box of listBoxes(db)) {
      if (box.kind !== "shared") await ensureQueued(box.id, true);
    }
  }

  async function resyncNow(box: Box): Promise<ResyncResult> {
    if (box.kind === "shared") {
      return { ok: false, problem: "The shared box's pooler is configured by pooler.exs." };
    }
    if (!isPoolerEligible(box)) {
      return { ok: false, problem: "This box has no pooler: it requires TLS." };
    }
    const tenant = box.poolerTenant ?? newTenantId(box);
    const problem = await create(box, tenant);
    if (problem !== undefined) {
      return { ok: false, problem: `Pooler tenant not re-synced: ${problem}` };
    }
    return { ok: true, tenant };
  }

  // Same no-fallback rule as ensureQueued.
  function resync(box: Box): Promise<ResyncResult> {
    return serialized(box.id, async () => {
      const current = getBoxById(db, box.id);
      if (current === undefined) return { ok: false, problem: "Box not found." };
      try {
        return await resyncNow(current);
      } catch (error) {
        return { ok: false, problem: `Pooler tenant not re-synced: ${scrubbed(error, [])}` };
      }
    });
  }

  return { ensure, drop, reconcile, resync };
}
