import { apiClient } from "../client.js";
import { deleteConfig, writeConfig } from "../config.js";
import { CliError, EXIT, UsageError } from "../errors.js";
import { printJson, printLines } from "../output.js";
import { readSecret } from "../prompt.js";
import { type Command, usageLine } from "./command.js";

interface Me {
  username: string;
}

function serverUrl(command: Command, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError(`${value} is not a URL`, usageLine(command));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UsageError(`${value} is not an http or https URL`, usageLine(command));
  }
  return value.replace(/\/+$/, "");
}

const login: Command = {
  name: "login",
  args: ["url"],
  options: [],
  usage: "login <url>",
  summary: "Save a server URL and API token",
  async run({ io, json }, [value = ""]) {
    const url = serverUrl(login, value);
    const token = await readSecret(io.stdin, io.stderr, "API token: ");
    if (token === "") throw new CliError(EXIT.usage, "no token given");
    const me = await apiClient(io.fetch, { url, token })<Me>("GET", "/me");
    writeConfig(io.configDir, { url, token });
    if (json) printJson(io.stdout, me);
    else printLines(io.stdout, `Logged in to ${url} as ${me.username}`);
  },
};

const logout: Command = {
  name: "logout",
  args: [],
  options: [],
  usage: "logout",
  summary: "Forget the saved URL and token",
  async run({ io }) {
    deleteConfig(io.configDir);
    printLines(io.stdout, "Logged out");
  },
};

const whoami: Command = {
  name: "whoami",
  args: [],
  options: [],
  usage: "whoami",
  summary: "Show the user and server in use",
  async run({ io, json, credentials, api }) {
    const { url } = credentials();
    const me = await api()<Me>("GET", "/me");
    if (json) printJson(io.stdout, me);
    else printLines(io.stdout, `${me.username} at ${url}`);
  },
};

export const authCommands = [login, logout, whoami];
