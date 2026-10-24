import type { Box } from "../registry/boxes.js";
import { POOLER_AUTH_QUERY } from "./role.js";
import type { TenantBody } from "./supavisor.js";

const POOL_SIZE = 20;
const MAX_CLIENTS = 100;

export type PoolerStatus =
  | { kind: "tenant"; id: string }
  | { kind: "pending" }
  | { kind: "direct" };

// Clients reach Supavisor without TLS and it cannot check an upstream host name, so a box that
// asks for TLS is never pooled.
export function isPoolerEligible(box: Pick<Box, "kind" | "sslmode">): boolean {
  return box.kind === "managed" || (box.kind === "registered" && box.sslmode === "disable");
}

export function tenantIdFor(
  prefix: string,
  box: Pick<Box, "id" | "name">,
  taken: Iterable<string>,
): string {
  const id = `${prefix}-${box.name}`;
  return new Set(taken).has(id) ? `${id}-${box.id}` : id;
}

export interface TenantManager {
  role: string;
  password: string;
}

export function tenantBody(box: Pick<Box, "host" | "port">, manager: TenantManager): TenantBody {
  return {
    db_host: box.host,
    db_port: box.port,
    db_database: "postgres",
    require_user: false,
    auth_query: POOLER_AUTH_QUERY,
    upstream_ssl: false,
    ip_version: "auto",
    default_pool_size: POOL_SIZE,
    default_max_clients: MAX_CLIENTS,
    users: [
      {
        db_user: manager.role,
        db_password: manager.password,
        mode_type: "transaction",
        pool_size: POOL_SIZE,
        is_manager: true,
      },
    ],
  };
}

export function poolerStatus(box: Box): PoolerStatus {
  const eligible = isPoolerEligible(box);
  if (box.poolerTenant !== null && (box.kind === "shared" || eligible)) {
    return { kind: "tenant", id: box.poolerTenant };
  }
  return eligible ? { kind: "pending" } : { kind: "direct" };
}
