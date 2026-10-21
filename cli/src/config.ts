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

export function readConfig(dir: string): Partial<Credentials> {
  const path = configFile(dir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const fd = openSync(configFile(dir), "w", 0o600);
  try {
    // An existing file keeps its old mode on open, so tighten it before the token is written.
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(credentials, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function deleteConfig(dir: string): void {
  rmSync(configFile(dir), { force: true });
}

export function credentials(env: Record<string, string | undefined>, dir: string): Credentials {
  const config = readConfig(dir);
  const url = env.HATTISAR_URL || config.url;
  const token = env.HATTISAR_TOKEN || config.token;
  if (!url || !token) {
    throw new CliError(EXIT.auth, "not logged in — run hattisar login <url>");
  }
  return { url: url.replace(/\/+$/, ""), token };
}
