import type { Project } from "./projects-source.js";

export function adminConnectionString(project: Pick<Project, "dbName" | "box">): string {
  const { host, port, adminUser, adminPassword } = project.box;
  const user = encodeURIComponent(adminUser);
  const password = encodeURIComponent(adminPassword);
  return `postgresql://${user}:${password}@${host}:${port}/${project.dbName}`;
}
