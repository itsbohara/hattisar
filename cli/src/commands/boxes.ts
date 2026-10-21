import { printJson, printLines, table } from "../output.js";
import type { Command } from "./command.js";

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

export const boxCommands = [list];
