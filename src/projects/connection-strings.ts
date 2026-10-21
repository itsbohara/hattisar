import type { Box } from "../registry/boxes.js";
import type { Project } from "../registry/projects.js";

export const MASK = "••••••••";

export const DIRECT_LABEL = "Direct";
export const SESSION_POOLER_LABEL = "Session pooler";
export const TRANSACTION_POOLER_LABEL = "Transaction pooler";

export type ProjectEndpoint = Pick<
  Box,
  "publicHost" | "publicPort" | "poolerTenant" | "poolerSessionPort" | "poolerTransactionPort"
>;

export interface ConnectionString {
  label: string;
  url: string;
  masked: string;
}

export function ownerConnectionStrings(
  box: ProjectEndpoint,
  project: Pick<Project, "dbName" | "ownerRole">,
  password: string,
): ConnectionString[] {
  const build = (label: string, user: string, port: number): ConnectionString => {
    const url = (secret: string) =>
      `postgresql://${user}:${secret}@${box.publicHost}:${port}/${project.dbName}`;
    return { label, url: url(encodeURIComponent(password)), masked: url(MASK) };
  };
  const { poolerTenant, poolerSessionPort, poolerTransactionPort } = box;
  if (poolerTenant !== null && poolerSessionPort !== null && poolerTransactionPort !== null) {
    const user = `${project.ownerRole}.${poolerTenant}`;
    return [
      build(SESSION_POOLER_LABEL, user, poolerSessionPort),
      build(TRANSACTION_POOLER_LABEL, user, poolerTransactionPort),
    ];
  }
  return [build(DIRECT_LABEL, project.ownerRole, box.publicPort)];
}
