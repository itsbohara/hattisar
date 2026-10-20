import pg from "pg";

export const SSL_MODES = ["disable", "require", "verify-full"] as const;
export type SslMode = (typeof SSL_MODES)[number];

export interface BoxConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  sslmode: SslMode;
}

const CONNECT_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 10_000;

export function isSslMode(value: string): value is SslMode {
  return (SSL_MODES as readonly string[]).includes(value);
}

function sslOption(mode: SslMode): pg.ClientConfig["ssl"] {
  if (mode === "disable") return false;
  return { rejectUnauthorized: mode === "verify-full" };
}

// Error messages from here reach the UI, so the password is scrubbed even though pg rarely echoes it.
export function safeErrorMessage(error: unknown, password: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return password === "" ? message : message.replaceAll(password, "********");
}

export async function withAdminClient<T>(
  conn: BoxConnection,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: "postgres",
    ssl: sslOption(conn.sslmode),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}
