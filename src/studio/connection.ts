import type { Project } from "./projects-source.js";

// Studio connects as the project's owner role, never the box admin: objects made in Studio must be
// owned by the role apps use (§7).
export function studioConnectionString(
  project: Pick<Project, "dbName" | "ownerRole" | "ownerPassword"> & {
    box: Pick<Project["box"], "host" | "port" | "sslmode">;
  },
): string {
  const { host, port, sslmode } = project.box;
  const user = encodeURIComponent(project.ownerRole);
  const password = encodeURIComponent(project.ownerPassword);
  const params = sslmode === "disable" ? "" : `?sslmode=${encodeURIComponent(sslmode)}`;
  return `postgresql://${user}:${password}@${host}:${port}/${project.dbName}${params}`;
}
