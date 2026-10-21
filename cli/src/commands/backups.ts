import { UsageError } from "../errors.js";
import { formatBytes, printJson, printLines, table, utc } from "../output.js";
import { type Command, requireConfirm, usageLine } from "./command.js";

interface Backup {
  id: number;
  kind: string;
  status: string;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const path = (ref: string) => `/projects/${encodeURIComponent(ref)}/backups`;

const list: Command = {
  name: "backups list",
  args: ["ref"],
  options: [],
  usage: "backups list <ref>",
  summary: "List a project's backups",
  async run({ io, json, api }, [ref = ""]) {
    const backups = await api()<Backup[]>("GET", path(ref));
    if (json) return printJson(io.stdout, backups);
    if (backups.length === 0) return printLines(io.stdout, `No backups of ${ref}`);
    printLines(
      io.stdout,
      table([
        ["ID", "KIND", "STATUS", "SIZE", "CREATED", "ERROR"],
        ...backups.map((b) => [
          String(b.id),
          b.kind,
          b.status,
          formatBytes(b.sizeBytes),
          utc(b.createdAt),
          b.error ?? "",
        ]),
      ]),
    );
  },
};

const run: Command = {
  name: "backups run",
  args: ["ref"],
  options: [],
  usage: "backups run <ref>",
  summary: "Back a project up now",
  async run({ io, json, api }, [ref = ""]) {
    const backup = await api()<Backup>("POST", path(ref));
    if (json) printJson(io.stdout, backup);
    else
      printLines(
        io.stdout,
        `Backup ${backup.id} of ${ref} done (${formatBytes(backup.sizeBytes)})`,
      );
  },
};

const restore: Command = {
  name: "backups restore",
  args: ["ref", "backup-id"],
  options: ["confirm"],
  usage: "backups restore <ref> <backup-id> --confirm <ref>",
  summary: "Restore a backup into its project",
  async run({ io, json, api }, [ref = "", id = ""], values) {
    if (!/^\d+$/.test(id)) throw new UsageError(`${id} is not a backup id`, usageLine(restore));
    requireConfirm(restore, ref, values);
    const result = await api()<unknown>("POST", `${path(ref)}/${id}/restore`, { confirm: ref });
    if (json) printJson(io.stdout, result);
    else printLines(io.stdout, `Restored backup ${id} into ${ref}`);
  },
};

export const backupCommands = [list, run, restore];
