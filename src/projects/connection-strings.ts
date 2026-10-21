import type { Box } from "../registry/boxes.js";
import type { Project } from "../registry/projects.js";

export const MASK = "••••••••";

export type ConnectionKind = "direct" | "session" | "transaction";

const LABELS: Record<ConnectionKind, string> = {
  direct: "Direct",
  session: "Session pooler",
  transaction: "Transaction pooler",
};

export type ProjectEndpoint = Pick<
  Box,
  "publicHost" | "publicPort" | "poolerTenant" | "poolerSessionPort" | "poolerTransactionPort"
>;

export interface ConnectionString {
  kind: ConnectionKind;
  label: string;
  url: string;
  masked: string;
}

export function ownerConnectionStrings(
  box: ProjectEndpoint,
  project: Pick<Project, "dbName" | "ownerRole">,
  password: string,
): ConnectionString[] {
  const build = (kind: ConnectionKind, user: string, port: number): ConnectionString => {
    const url = (secret: string) =>
      `postgresql://${user}:${secret}@${box.publicHost}:${port}/${project.dbName}`;
    return { kind, label: LABELS[kind], url: url(encodeURIComponent(password)), masked: url(MASK) };
  };
  const { poolerTenant, poolerSessionPort, poolerTransactionPort } = box;
  if (poolerTenant !== null && poolerSessionPort !== null && poolerTransactionPort !== null) {
    const user = `${project.ownerRole}.${poolerTenant}`;
    return [
      build("session", user, poolerSessionPort),
      build("transaction", user, poolerTransactionPort),
    ];
  }
  return [build("direct", project.ownerRole, box.publicPort)];
}
