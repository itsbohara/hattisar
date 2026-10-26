import { boxConnection } from "../boxes/service.js";
import type { Box } from "../registry/boxes.js";
import type { Project } from "../registry/projects.js";
import type { ProjectAndBox } from "./access.js";
import { attachedConnection, isAttached } from "./attach.js";
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

// The box's reachability and its created projects come from one admin query per box, all at once:
// a box that is down costs its own connect timeout, not the sum.
export async function projectUsage(
  { secretKey, admin }: Pick<ProjectServiceDeps, "secretKey" | "admin">,
  rows: ProjectAndBox[],
): Promise<Usage> {
  const usage: Usage = { boxes: {}, projects: {} };
  await Promise.all(
    groupByBox(rows).map(async ({ box, projects }) => {
      const created = projects.filter((project) => !isAttached(project));
      try {
        const result = await admin(boxConnection(box, secretKey), (client) =>
          client.query<{ datname: string; bytes: string }>(SIZES_SQL, [
            created.map((project) => project.dbName),
          ]),
        );
        const sizes = new Map(result.rows.map((row) => [row.datname, Number(row.bytes)]));
        let total = 0;
        for (const project of created) {
          const bytes = sizes.get(project.dbName);
          if (bytes === undefined) continue;
          usage.projects[project.ref] = bytes;
          total += bytes;
        }
        const attachedSizes = await Promise.all(
          projects
            .filter(isAttached)
            .map((project) => attachedSize({ secretKey, admin }, project, box)),
        );
        for (const size of attachedSizes) {
          if (size === undefined) continue;
          usage.projects[size.ref] = size.bytes;
          total += size.bytes;
        }
        usage.boxes[box.id] = { reachable: true, bytes: total };
      } catch {
        usage.boxes[box.id] = { reachable: false, bytes: 0 };
      }
    }),
  );
  return usage;
}

// The box admin may not see an attached database's size or even connect to it, so it is sized on
// its own login. A failure here leaves only that project unsized: it says nothing about the box.
async function attachedSize(
  { secretKey, admin }: Pick<ProjectServiceDeps, "secretKey" | "admin">,
  project: Project,
  box: Box,
): Promise<{ ref: string; bytes: number } | undefined> {
  try {
    const result = await admin(
      attachedConnection(project, box, secretKey),
      (client) => client.query<{ datname: string; bytes: string }>(SIZES_SQL, [[project.dbName]]),
      project.dbName,
    );
    const row = result.rows[0];
    return row && { ref: project.ref, bytes: Number(row.bytes) };
  } catch {
    return undefined;
  }
}
