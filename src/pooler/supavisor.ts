import { createHmac } from "node:crypto";
import { safeErrorMessage } from "../boxes/admin-client.js";

export const SUPAVISOR_API_URL = "http://supavisor:4000";
const TOKEN_LIFETIME_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 10_000;
// Supavisor takes the tenant from the client user name after its last '.', so a '.' in the id
// would make the tenant unreachable; the id also goes into the URL path unescaped.
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface TenantUser {
  db_user: string;
  db_password: string;
  mode_type: "transaction";
  pool_size: number;
  is_manager: true;
}

export interface TenantBody {
  db_host: string;
  db_port: number;
  db_database: "postgres";
  require_user: false;
  auth_query: string;
  upstream_ssl: false;
  ip_version: "auto";
  default_pool_size: number;
  default_max_clients: number;
  users?: TenantUser[];
}

export interface TenantInfo {
  dbHost: string;
  dbPort: number;
}

export class SupavisorError extends Error {
  override name = "SupavisorError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// What the pooler service needs from Supavisor; SupavisorApi is the real one, tests may substitute.
export interface TenantApi {
  get(id: string): Promise<TenantInfo | undefined>;
  put(id: string, tenant: TenantBody, scrub?: string): Promise<void>;
  remove(id: string): Promise<void>;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signApiJwt(secret: string, nowSeconds: number): string {
  const unsigned = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ exp: nowSeconds + TOKEN_LIFETIME_SECONDS })}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function tenantPath(id: string): string {
  if (!TENANT_ID_PATTERN.test(id)) throw new Error(`Invalid Supavisor tenant id: ${id}`);
  return `/api/tenants/${id}`;
}

async function errorField(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: unknown } | null)?.error;
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

export class SupavisorApi implements TenantApi {
  private readonly jwtSecret: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(opts: {
    jwtSecret: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.jwtSecret = opts.jwtSecret;
    this.baseUrl = opts.baseUrl ?? SUPAVISOR_API_URL;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async get(id: string): Promise<TenantInfo | undefined> {
    const response = await this.request("GET", tenantPath(id), [404]);
    if (response.status === 404) return undefined;
    const { data } = (await response.json()) as { data: { db_host: string; db_port: number } };
    return { dbHost: data.db_host, dbPort: data.db_port };
  }

  async put(id: string, tenant: TenantBody, scrub?: string): Promise<void> {
    await this.request("PUT", tenantPath(id), [], { tenant }, scrub);
  }

  async remove(id: string): Promise<void> {
    const path = tenantPath(id);
    await this.request("GET", `${path}/terminate`, [404]);
    await this.request("DELETE", path, [404]);
  }

  private async request(
    method: string,
    path: string,
    tolerated: number[],
    body?: unknown,
    scrub = "",
  ): Promise<Response> {
    const action = `Supavisor ${method} ${path}`;
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${signApiJwt(this.jwtSecret, this.now())}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
      throw new SupavisorError(`${action} failed: Supavisor ${reason}`, 0);
    }
    if (response.ok || tolerated.includes(response.status)) return response;
    if (response.status === 403) {
      throw new SupavisorError(`${action} failed: Supavisor rejected the API token`, 403);
    }
    const detail = await errorField(response);
    const message =
      detail === undefined ? `HTTP ${response.status}` : safeErrorMessage(detail, scrub);
    throw new SupavisorError(`${action} failed: ${message}`, response.status);
  }
}
