export interface PortRange {
  start: number;
  end: number;
}

export interface Config {
  secretKey: string;
  adminUsername: string;
  adminPassword: string | undefined;
  publicHost: string;
  port: number;
  dataDir: string;
  cookieSecure: boolean;
  purgeAfterDays: number;
  backupHourUtc: number;
  pgBinDir: string;
  managedBoxes: boolean;
  managedPortRange: PortRange;
  dockerHost: string;
  studioUrl: string;
  pgMetaUrl: string;
  pgMetaCryptoKey: string;
  pgMetaTimeoutSeconds: number;
  postgresPassword: string;
  pooler: {
    tenantId: string;
    jwtSecret: string;
    portSession: number;
    portTransaction: number;
  };
  debug: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Env = Record<string, string | undefined>;

// Messages name the variable but never echo its value: several of these are secrets.
class EnvReader {
  constructor(private readonly env: Env) {}

  private raw(name: string): string | undefined {
    const value = this.env[name];
    return value === undefined || value === "" ? undefined : value;
  }

  string(name: string, fallback: string): string {
    return this.raw(name) ?? fallback;
  }

  required(name: string, minLength = 1): string {
    const value = this.raw(name);
    if (value === undefined) throw new ConfigError(`${name} is required`);
    if (value.length < minLength) {
      throw new ConfigError(`${name} must be at least ${minLength} characters`);
    }
    return value;
  }

  optional(name: string, minLength: number): string | undefined {
    return this.raw(name) === undefined ? undefined : this.required(name, minLength);
  }

  boolean(name: string, fallback: boolean): boolean {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new ConfigError(`${name} must be "true" or "false"`);
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const parsed = parseInteger(value);
    if (parsed === undefined || parsed < min || parsed > max) {
      throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
    }
    return parsed;
  }

  port(name: string, fallback: number): number {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const parsed = parseInteger(value);
    if (parsed === undefined || !isPort(parsed)) {
      throw new ConfigError(`${name} must be a port between 1 and 65535`);
    }
    return parsed;
  }

  portRange(name: string, fallback: PortRange): PortRange {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const [start, end, ...rest] = value.split("-").map(parseInteger);
    if (
      rest.length > 0 ||
      start === undefined ||
      end === undefined ||
      !isPort(start) ||
      !isPort(end) ||
      start > end
    ) {
      throw new ConfigError(`${name} must be <start>-<end> with 1 <= start <= end <= 65535`);
    }
    return { start, end };
  }

  url(name: string, fallback: string): string {
    const value = this.string(name, fallback);
    if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
      throw new ConfigError(`${name} must be an http(s) URL`);
    }
    return value;
  }
}

function parseInteger(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

function isPort(value: number): boolean {
  return value >= 1 && value <= 65535;
}

export function loadConfig(env: Env = process.env): Config {
  const read = new EnvReader(env);
  return {
    secretKey: read.required("HATTISAR_SECRET_KEY", 32),
    adminUsername: read.string("HATTISAR_ADMIN_USERNAME", "admin"),
    adminPassword: read.optional("HATTISAR_ADMIN_PASSWORD", 12),
    publicHost: read.string("HATTISAR_PUBLIC_HOST", "localhost"),
    port: read.port("HATTISAR_PORT", 8000),
    dataDir: read.string("HATTISAR_DATA_DIR", "/data"),
    cookieSecure: read.boolean("HATTISAR_COOKIE_SECURE", false),
    purgeAfterDays: read.integer("HATTISAR_PURGE_AFTER_DAYS", 7, 0, 3650),
    backupHourUtc: read.integer("HATTISAR_BACKUP_HOUR_UTC", 2, 0, 23),
    pgBinDir: read.string("HATTISAR_PG_BIN_DIR", "/usr/bin"),
    managedBoxes: read.boolean("HATTISAR_MANAGED_BOXES", false),
    managedPortRange: read.portRange("HATTISAR_MANAGED_PORT_RANGE", { start: 55000, end: 55999 }),
    dockerHost: read.string("DOCKER_HOST", "tcp://docker-proxy:2375"),
    studioUrl: read.url("STUDIO_URL", "http://studio:3000"),
    pgMetaUrl: read.url("PG_META_URL", "http://meta:8080"),
    pgMetaCryptoKey: read.required("PG_META_CRYPTO_KEY"),
    pgMetaTimeoutSeconds: read.integer("HATTISAR_PG_META_TIMEOUT_SECONDS", 120, 1, 86400),
    postgresPassword: read.required("POSTGRES_PASSWORD"),
    pooler: {
      tenantId: read.required("POOLER_TENANT_ID"),
      jwtSecret: read.required("POOLER_JWT_SECRET"),
      portSession: read.port("POOLER_PORT_SESSION", 54322),
      portTransaction: read.port("POOLER_PORT_TRANSACTION", 6543),
    },
    debug: read.boolean("HATTISAR_DEBUG", false),
  };
}
