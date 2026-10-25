import { UsageError } from "../errors.js";
import { printJson, printLines, table } from "../output.js";
import { type Command, usageLine } from "./command.js";

interface Box {
  id: number;
  name: string;
  kind: string;
  devOnly: boolean;
  publicHost: string;
  publicPort: number;
}

const list: Command = {
  name: "boxes list",
  args: [],
  options: [],
  usage: "boxes list",
  summary: "List the boxes projects can be created on",
  async run({ io, json, api }) {
    const boxes = await api()<Box[]>("GET", "/boxes");
    if (json) return printJson(io.stdout, boxes);
    printLines(
      io.stdout,
      table([
        ["ID", "NAME", "KIND", "ADDRESS", "DEV ONLY"],
        ...boxes.map((b) => [
          String(b.id),
          b.name,
          b.kind,
          `${b.publicHost}:${b.publicPort}`,
          b.devOnly ? "yes" : "no",
        ]),
      ]),
    );
  },
};

const resyncPooler: Command = {
  name: "boxes resync-pooler",
  args: ["id"],
  options: [],
  usage: "boxes resync-pooler <id>",
  summary: "Rebuild a box's pooler tenant; drops open pooled connections",
  async run({ io, json, api }, [id = ""]) {
    if (!/^\d+$/.test(id)) throw new UsageError(`${id} is not a box id`, usageLine(resyncPooler));
    const result = await api()<{ tenant: string }>("POST", `/boxes/${id}/pooler/resync`);
    if (json) printJson(io.stdout, result);
    else printLines(io.stdout, `Re-synced pooler tenant ${result.tenant}`);
  },
};

export const boxCommands = [list, resyncPooler];
