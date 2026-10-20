import type { Box } from "./projects-source.js";

export function adminConnectionString(project: {
  dbName: string;
  box: Pick<Box, "host" | "port" | "adminUser" | "adminPassword">;
}): string {
  const { host, port, adminUser, adminPassword } = project.box;
  const user = encodeURIComponent(adminUser);
  const password = encodeURIComponent(adminPassword);
  return `postgresql://${user}:${password}@${host}:${port}/${project.dbName}`;
}
