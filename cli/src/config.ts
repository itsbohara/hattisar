import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT } from "./errors.js";

export interface Credentials {
  url: string;
  token: string;
}

export function defaultConfigDir(env: Record<string, string | undefined>): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "hattisar");
}

const configFile = (dir: string) => join(dir, "config.json");

function fsFailure(action: string, path: string, error: unknown): CliError {
  const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
  return new CliError(EXIT.api, `cannot ${action} ${path}: ${code}`);
}

// The value is never echoed: a URL that fails these checks may carry a password.
export function serverUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError(EXIT.usage, "the URL is not valid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(EXIT.usage, "the URL must be http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CliError(EXIT.usage, "the URL must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "" || /[?#]/.test(value)) {
    throw new CliError(EXIT.usage, "the URL must not contain a query or fragment");
  }
  return value.replace(/\/+$/, "");
}

// The value is never echoed: a token that fails this check could still be a real one.
export function apiToken(value: string): string {
  const token = value.trim();
  if (!/^hs_[A-Za-z0-9_-]+$/.test(token)) throw new CliError(EXIT.auth, "the token is not valid");
  return token;
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export function sendsTokenInClear(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return protocol === "http:" && !LOOPBACK.includes(hostname);
}

export function readConfig(dir: string): Partial<Credentials> {
  const path = configFile(dir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw fsFailure("read", path, error);
  }
  try {
    const { url, token } = JSON.parse(text) as Record<string, unknown>;
    return {
      url: typeof url === "string" ? url : undefined,
      token: typeof token === "string" ? token : undefined,
    };
  } catch {
    throw new CliError(EXIT.api, `${path} is not valid JSON — run hattisar login <url>`);
  }
}

export function writeConfig(dir: string, credentials: Credentials): void {
  const path = configFile(dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const fd = openSync(path, "w", 0o600);
    try {
      // An existing file keeps its old mode on open, so tighten it before the token is written.
      fchmodSync(fd, 0o600);
      writeSync(fd, `${JSON.stringify(credentials, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw fsFailure("write", path, error);
  }
}

export function deleteConfig(dir: string): void {
  const path = configFile(dir);
  try {
    rmSync(path, { force: true });
  } catch (error) {
    throw fsFailure("delete", path, error);
  }
}

export function credentials(env: Record<string, string | undefined>, dir: string): Credentials {
  const config = readConfig(dir);
  const savedUrl = config.url?.replace(/\/+$/, "");
  const url = env.HATTISAR_URL ? serverUrl(env.HATTISAR_URL) : savedUrl;
  // A saved token goes only to the server it was saved for, never to one HATTISAR_URL names.
  const token = env.HATTISAR_TOKEN?.trim() || (url === savedUrl ? config.token : undefined);
  if (!url || !token) {
    throw new CliError(
      EXIT.auth,
      env.HATTISAR_URL ? `not logged in to ${url}` : "not logged in — run hattisar login <url>",
    );
  }
  return { url, token: apiToken(token) };
}
