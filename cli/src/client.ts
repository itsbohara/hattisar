import type { Credentials } from "./config.js";
import { CliError, EXIT } from "./errors.js";

export type Fetch = (request: Request) => Promise<Response>;

export type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

// Only the error code is shown: a message from the request layer can quote the request's headers,
// and with them the token.
function reason(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? `: ${code}` : "";
}

function redirected(url: string, endpoint: string, response: Response): CliError {
  const location = response.headers.get("location");
  if (location === null) return new CliError(EXIT.api, `${url} answered a redirect`);
  let target: string;
  try {
    const parsed = new URL(location, endpoint);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    target = parsed.href.replace(/\/_hs\/api\/v1\/.*$/, "");
  } catch {
    return new CliError(EXIT.api, `${url} answered a redirect`);
  }
  return new CliError(EXIT.api, `${url} redirected to ${target} — log in with that URL instead`);
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
    const endpoint = `${url}/_hs/api/v1${path}`;
    let response: Response;
    try {
      response = await fetch(
        new Request(endpoint, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          // Following would resend the token wherever the server points, or drop it on a scheme
          // change and surface as a misleading "invalid API token".
          redirect: "manual",
        }),
      );
    } catch (error) {
      throw new CliError(EXIT.api, `cannot reach ${url}${reason(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw redirected(url, endpoint, response);
    }
    if (!response.ok) throw await failure(response);
    try {
      return (await response.json()) as T;
    } catch {
      throw new CliError(EXIT.api, `unexpected response from ${url}`);
    }
  };
}
