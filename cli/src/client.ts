import type { Credentials } from "./config.js";
import { CliError, EXIT } from "./errors.js";

export type Fetch = (request: Request) => Promise<Response>;

export type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

function causeOf(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

async function failure(response: Response): Promise<CliError> {
  const exitCode = response.status === 401 ? EXIT.auth : EXIT.api;
  try {
    const { error } = (await response.json()) as {
      error?: { message?: unknown; problems?: unknown };
    };
    if (typeof error?.message === "string") {
      const problems = Array.isArray(error.problems) ? error.problems.map(String) : [];
      return new CliError(exitCode, error.message, problems);
    }
  } catch {}
  return new CliError(exitCode, `HTTP ${response.status} ${response.statusText}`.trim());
}

export function apiClient(fetch: Fetch, { url, token }: Credentials): Api {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(
        new Request(`${url}/_hs/api/v1${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    } catch (error) {
      throw new CliError(EXIT.api, `cannot reach ${url}: ${causeOf(error)}`);
    }
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  };
}
