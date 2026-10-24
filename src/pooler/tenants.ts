import { randomBytes } from "node:crypto";
import { type AdminClientRunner, safeErrorMessage } from "../boxes/admin-client.js";
import { boxConnection } from "../boxes/service.js";
import { type Box, getBoxById, listBoxes, updateBox } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { installPoolerRole } from "./role.js";
import type { TenantApi, TenantInfo } from "./supavisor.js";
import { isPoolerEligible, tenantBody, tenantIdFor } from "./tenant-spec.js";

export interface PoolerTenants {
  ensure(box: Box): Promise<void>;
  drop(box: Box): Promise<void>;
  reconcile(): Promise<void>;
}

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

export function createPoolerTenants(deps: PoolerTenantsDeps): PoolerTenants {
  const { db, api } = deps;
  const queues = new Map<number, Promise<void>>();

  // Every step re-reads the box inside its turn: a queued ensure must see the tenant the one
  // before it stored, or it would PUT again and drop the pools that PUT just created.
  function serialized(id: number, step: () => Promise<void>): Promise<void> {
    const next = (queues.get(id) ?? Promise.resolve()).then(step);
    queues.set(id, next);
    void next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    });
    return next;
  }

  function warn(box: Box, action: string, error: unknown, password = ""): void {
    console.warn(
      `hattisar: pooler tenant for box ${box.name} not ${action}: ${safeErrorMessage(error, password)}`,
    );
  }

  async function create(box: Box, id: string): Promise<void> {
    const password = randomBytes(32).toString("base64url");
    try {
      await deps.admin(
        boxConnection(box, deps.secretKey),
        (client) => installPoolerRole(client, password),
        "postgres",
      );
      await api.put(id, tenantBody(box, password), password);
    } catch (error) {
      warn(box, "created", error, password);
      return;
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
    if (tenant === undefined) return create(box, id);
    if (tenant.dbHost === box.host && tenant.dbPort === box.port) return;
    try {
      await api.put(id, tenantBody(box));
    } catch (error) {
      warn(box, "updated", error);
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
  }

  async function ensureNow(box: Box): Promise<void> {
    if (box.kind === "shared") return;
    if (!isPoolerEligible(box)) return dropNow(box);
    if (box.poolerTenant !== null) return ensureStored(box, box.poolerTenant);
    const taken = listBoxes(db).flatMap((other) =>
      other.id !== box.id && other.poolerTenant !== null ? [other.poolerTenant] : [],
    );
    await create(box, tenantIdFor(deps.tenantPrefix, box, taken));
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

  return { ensure, drop, reconcile };
}
