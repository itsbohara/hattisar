import type { Box } from "./projects-source.js";

export function adminConnectionString(project: {
  dbName: string;
  box: Pick<Box, "host" | "port" | "adminUser" | "adminPassword" | "sslmode">;
}): string {
  const { host, port, adminUser, adminPassword, sslmode } = project.box;
  const user = encodeURIComponent(adminUser);
  const password = encodeURIComponent(adminPassword);
  const params = sslmode === "disable" ? "" : `?sslmode=${encodeURIComponent(sslmode)}`;
  return `postgresql://${user}:${password}@${host}:${port}/${project.dbName}${params}`;
}
