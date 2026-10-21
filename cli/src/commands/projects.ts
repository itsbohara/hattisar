import { CliError, EXIT, UsageError } from "../errors.js";
import { printJson, printLines, table, utc } from "../output.js";
import { type Command, type Context, requireConfirm, usageLine } from "./command.js";

interface Project {
  ref: string;
  name: string;
  status: string;
  box: { id: number; name: string; kind: string };
  createdAt: string;
  deletedAt: string | null;
}

interface Connection {
  label: string;
  kind: "direct" | "session" | "transaction";
}

interface ProjectDetail extends Project {
  connections: (Connection & { masked: string })[];
}

interface Ok {
  ok: true;
}

const path = (ref: string) => `/projects/${encodeURIComponent(ref)}`;

function done({ io, json }: Context, result: unknown, message: string): void {
  if (json) printJson(io.stdout, result);
  else printLines(io.stdout, message);
}

const list: Command = {
  name: "projects list",
  args: [],
  options: ["deleted"],
  usage: "projects list [--deleted]",
  summary: "List projects, or the ones in the trash",
  async run({ io, json, api }, _args, values) {
    const status = values.deleted ? "deleted" : "active";
    const projects = await api()<Project[]>("GET", `/projects?status=${status}`);
    if (json) return printJson(io.stdout, projects);
    if (projects.length === 0) return printLines(io.stdout, `No ${status} projects`);
    const when = values.deleted ? "DELETED" : "CREATED";
    printLines(
      io.stdout,
      table([
        ["REF", "NAME", "BOX", when],
        ...projects.map((p) => [
          p.ref,
          p.name,
          p.box.name,
          utc(values.deleted ? p.deletedAt : p.createdAt),
        ]),
      ]),
    );
  },
};

function boxChoice(values: Record<string, unknown>): { boxId?: number; newBox?: true } {
  if (values.box !== undefined && values["new-box"]) {
    throw new UsageError("give either --box or --new-box, not both", usageLine(create));
  }
  if (values["new-box"]) return { newBox: true };
  if (typeof values.box !== "string") return {};
  if (!/^\d+$/.test(values.box)) {
    throw new UsageError(`--box must be a box id, not ${values.box}`, usageLine(create));
  }
  return { boxId: Number(values.box) };
}

const create: Command = {
  name: "projects create",
  args: ["name"],
  options: ["ref", "box", "new-box"],
  usage: "projects create <name> [--ref <ref>] [--box <id> | --new-box]",
  summary: "Create a project, on the shared box by default",
  async run(context, [name], values) {
    const body = { name, ref: values.ref, ...boxChoice(values) };
    const project = await context.api()<Project>("POST", "/projects", body);
    done(context, project, `Created ${project.ref} on ${project.box.name}`);
  },
};

const show: Command = {
  name: "projects show",
  args: ["ref"],
  options: [],
  usage: "projects show <ref>",
  summary: "Show a project, passwords masked",
  async run({ io, json, api }, [ref = ""]) {
    const project = await api()<ProjectDetail>("GET", path(ref));
    if (json) return printJson(io.stdout, project);
    printLines(
      io.stdout,
      table([
        ["Ref", project.ref],
        ["Name", project.name],
        ["Status", project.status],
        ["Box", `${project.box.name} (${project.box.kind})`],
        ["Created", utc(project.createdAt)],
        ...project.connections.map(({ label, masked }) => [label, masked]),
      ]),
    );
  },
};

const url: Command = {
  name: "projects url",
  args: ["ref"],
  options: ["transaction"],
  usage: "projects url <ref> [--transaction]",
  summary: "Print the connection URL with its password",
  async run({ io, json, api }, [ref = ""], values) {
    const connections = await api()<(Connection & { url: string })[]>(
      "GET",
      `${path(ref)}/connections`,
    );
    const connection = values.transaction
      ? connections.find(({ kind }) => kind === "transaction")
      : connections[0];
    if (connection === undefined) {
      throw new CliError(
        EXIT.api,
        values.transaction ? `${ref} has no transaction pooler` : `${ref} has no connection URL`,
      );
    }
    if (json) printJson(io.stdout, connection);
    else printLines(io.stdout, connection.url);
  },
};

const rotate: Command = {
  name: "projects rotate",
  args: ["ref"],
  options: [],
  usage: "projects rotate <ref>",
  summary: "Rotate the project owner's password",
  async run(context, [ref = ""]) {
    const result = await context.api()<Ok>("POST", `${path(ref)}/rotate`);
    done(context, result, `Rotated the owner password of ${ref}`);
  },
};

const remove: Command = {
  name: "projects delete",
  args: ["ref"],
  options: ["confirm"],
  usage: "projects delete <ref> --confirm <ref>",
  summary: "Move a project to the trash",
  async run(context, [ref = ""], values) {
    requireConfirm(remove, ref, values);
    const result = await context.api()<Ok>("DELETE", path(ref), { confirm: ref });
    done(context, result, `Moved ${ref} to the trash`);
  },
};

const restore: Command = {
  name: "projects restore",
  args: ["ref"],
  options: [],
  usage: "projects restore <ref>",
  summary: "Restore a project from the trash",
  async run(context, [ref = ""]) {
    const project = await context.api()<Project>("POST", `${path(ref)}/undelete`);
    done(context, project, `Restored ${project.ref} from the trash`);
  },
};

export const projectCommands = [list, create, show, url, rotate, remove, restore];
