import type { Api, Fetch } from "../client.js";
import type { Credentials } from "../config.js";
import { CliError, EXIT, UsageError } from "../errors.js";
import type { Writer } from "../output.js";
import type { Input } from "../prompt.js";

export interface Io {
  fetch: Fetch;
  stdout: Writer;
  stderr: Writer;
  stdin: Input;
  env: Record<string, string | undefined>;
  configDir: string;
}

export interface Context {
  io: Io;
  json: boolean;
  credentials(): Credentials;
  api(): Api;
}

export type Values = Record<string, string | boolean | undefined>;

export interface Command {
  name: string;
  args: string[];
  options: string[];
  usage: string;
  summary: string;
  run(context: Context, args: string[], values: Values): Promise<void>;
}

export function usageLine(command: Command): string {
  return `usage: hattisar ${command.usage}`;
}

export function requireConfirm(command: Command, ref: string, values: Values): void {
  if (typeof values.confirm !== "string") {
    throw new UsageError(`${command.name} needs --confirm <ref>`, usageLine(command));
  }
  if (values.confirm !== ref) throw new CliError(EXIT.usage, `--confirm must be the ref ${ref}`);
}
