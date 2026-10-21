import { boxConnection } from "../boxes/service.js";
import type { Box } from "../registry/boxes.js";
import type { Project } from "../registry/projects.js";
import type { ProjectAndBox } from "./access.js";
import type { ProjectServiceDeps } from "./service.js";

export interface BoxUsage {
  reachable: boolean;
  bytes: number;
}

export interface Usage {
  boxes: Record<number, BoxUsage>;
  projects: Record<string, number>;
}

const SIZES_SQL =
  "select datname, pg_database_size(datname) as bytes from pg_database where datname = any($1::text[])";

function groupByBox(rows: ProjectAndBox[]): { box: Box; projects: Project[] }[] {
  const groups = new Map<number, { box: Box; projects: Project[] }>();
  for (const { project, box } of rows) {
    const group = groups.get(box.id) ?? { box, projects: [] };
    group.projects.push(project);
    groups.set(box.id, group);
  }
  return [...groups.values()];
}

// One query per box, all at once: a box that is down costs its own connect timeout, not the sum.
export async function projectUsage(
  { secretKey, admin }: Pick<ProjectServiceDeps, "secretKey" | "admin">,
  rows: ProjectAndBox[],
): Promise<Usage> {
  const usage: Usage = { boxes: {}, projects: {} };
  await Promise.all(
    groupByBox(rows).map(async ({ box, projects }) => {
      try {
        const result = await admin(boxConnection(box, secretKey), (client) =>
          client.query<{ datname: string; bytes: string }>(SIZES_SQL, [
            projects.map((project) => project.dbName),
          ]),
        );
        const sizes = new Map(result.rows.map((row) => [row.datname, Number(row.bytes)]));
        let total = 0;
        for (const project of projects) {
          const bytes = sizes.get(project.dbName);
          if (bytes === undefined) continue;
          usage.projects[project.ref] = bytes;
          total += bytes;
        }
        usage.boxes[box.id] = { reachable: true, bytes: total };
      } catch {
        usage.boxes[box.id] = { reachable: false, bytes: 0 };
      }
    }),
  );
  return usage;
}
