import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { apiClient } from "./client.js";
import { authCommands } from "./commands/auth.js";
import { backupCommands } from "./commands/backups.js";
import { boxCommands } from "./commands/boxes.js";
import { type Command, type Context, type Io, usageLine, type Values } from "./commands/command.js";
import { projectCommands } from "./commands/projects.js";
import { credentials } from "./config.js";
import { CliError, EXIT, type ExitCode, UsageError } from "./errors.js";
import { printLines, table } from "./output.js";

export type { Io } from "./commands/command.js";

const COMMANDS: Command[] = [
  ...authCommands,
  ...projectCommands,
  ...backupCommands,
  ...boxCommands,
];

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  deleted: { type: "boolean" },
  "new-box": { type: "boolean" },
  transaction: { type: "boolean" },
  ref: { type: "string" },
  box: { type: "string" },
  confirm: { type: "string" },
} as const;

const GLOBAL_OPTIONS = ["json", "help", "version"];

function version(): string {
  // Both src/ and dist/ sit beside package.json, so the same relative path works under tsx and node.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return (pkg as { version: string }).version;
}

function overview(commands = COMMANDS): string {
  return [
    "usage: hattisar <command> [--json]",
    "",
    table(commands.map((command) => [`  ${command.usage}`, command.summary])),
    "",
    "Global options: --json prints the API's JSON, --help, --version.",
    "Credentials come from hattisar login, or HATTISAR_URL and HATTISAR_TOKEN.",
  ].join("\n");
}

const flag = (name: string) => (name.length === 1 ? `-${name}` : `--${name}`);

function checkOptions(command: Command, values: Values): void {
  for (const [name, value] of Object.entries(values)) {
    if (!GLOBAL_OPTIONS.includes(name) && !command.options.includes(name)) {
      throw new UsageError(`unknown option ${flag(name)} for ${command.name}`, usageLine(command));
    }
    const type = (OPTIONS as Record<string, { type: string }>)[name]?.type;
    if (type === "string" && typeof value !== "string") {
      throw new UsageError(`${flag(name)} needs a value`, usageLine(command));
    }
  }
}

function commandArgs(command: Command, positionals: string[]): string[] {
  const args = positionals.slice(command.name.split(" ").length);
  const missing = command.args[args.length];
  if (missing !== undefined) throw new UsageError(`missing <${missing}>`, usageLine(command));
  const extra = args[command.args.length];
  if (extra !== undefined) throw new UsageError(`unexpected argument ${extra}`, usageLine(command));
  return args;
}

function findCommand(positionals: string[]): Command | undefined {
  return COMMANDS.find((command) =>
    command.name.split(" ").every((word, i) => positionals[i] === word),
  );
}

async function dispatch(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
  });
  if (values.version) {
    printLines(io.stdout, version());
    return EXIT.ok;
  }
  const command = findCommand(positionals);
  if (command === undefined) {
    const [group] = positionals;
    const inGroup = COMMANDS.filter(({ name }) => name.startsWith(`${group} `));
    const usage = overview(inGroup.length > 0 ? inGroup : COMMANDS);
    if (values.help && positionals.length <= 1) {
      printLines(io.stdout, usage);
      return EXIT.ok;
    }
    if (group === undefined || (positionals.length === 1 && inGroup.length > 0)) {
      throw new UsageError("missing command", usage);
    }
    throw new UsageError(`unknown command ${positionals.join(" ")}`, usage);
  }
  if (values.help) {
    printLines(io.stdout, `${usageLine(command)}\n\n${command.summary}`);
    return EXIT.ok;
  }
  checkOptions(command, values);
  const args = commandArgs(command, positionals);
  const context: Context = {
    io,
    json: values.json === true,
    credentials: () => credentials(io.env, io.configDir),
    api: () => apiClient(io.fetch, context.credentials()),
  };
  await command.run(context, args, values);
  return EXIT.ok;
}

export async function run(argv: string[], io: Io): Promise<ExitCode> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.stderr.write(`hattisar: ${error.message}\n`);
    for (const problem of error.problems) io.stderr.write(`  - ${problem}\n`);
    if (error instanceof UsageError) io.stderr.write(`${error.usage}\n`);
    return error.exitCode;
  }
}
