import { adminConnectionString } from "./connection.js";
import { encryptConnectionString } from "./crypto.js";
import type { Project } from "./projects-source.js";

export const CONNECTION_HEADER = "x-connection-encrypted";

export interface PgMetaLogEntry {
  at: string;
  method: string;
  path: string;
  ref: string;
  box: string;
  db: string;
}

export class PgMetaLog {
  private readonly entries: PgMetaLogEntry[] = [];

  constructor(private readonly limit = 200) {}

  record(entry: PgMetaLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  recent(): PgMetaLogEntry[] {
    return [...this.entries];
  }
}

export function encryptedConnection(project: Project, cryptoKey: string): string {
  return encryptConnectionString(adminConnectionString(project), cryptoKey);
}

export function connectionHeaders(project: Project, cryptoKey: string): Headers {
  return new Headers({ [CONNECTION_HEADER]: encryptedConnection(project, cryptoKey) });
}

interface QueryResult {
  status: number;
  body: unknown;
}

function errorResult(status: number, message: string, formattedError?: string): QueryResult {
  return { status, body: { message, formattedError: formattedError ?? message } };
}

function errorField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

// Mirrors Studio's pages/api/platform/pg-meta/[ref]/query so the Studio UI sees identical shapes.
export async function runQuery(
  pgMetaUrl: string,
  project: Project,
  cryptoKey: string,
  requestBody: unknown,
): Promise<QueryResult> {
  const query = errorField(requestBody, "query");
  if (query === undefined) return errorResult(400, "Request body must be {query, parameters?}");
  const parameters = (requestBody as Record<string, unknown>).parameters;

  let response: Response;
  let body: unknown;
  try {
    response = await fetch(new URL("/query", pgMetaUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CONNECTION_HEADER]: encryptedConnection(project, cryptoKey),
      },
      body: JSON.stringify(parameters === undefined ? { query } : { query, parameters }),
    });
    body = await response.json();
  } catch (error) {
    return errorResult(500, error instanceof Error ? error.message : "pg-meta request failed");
  }

  if (response.ok) return { status: 200, body };
  const message = errorField(body, "message") ?? `pg-meta responded ${response.status}`;
  return errorResult(response.status, message, errorField(body, "formattedError"));
}
