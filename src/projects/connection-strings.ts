import { ownerLogin } from "../boxes/owner-login.js";
import type { Box } from "../registry/boxes.js";
import type { Project } from "../registry/projects.js";
import { isAttached } from "./attach.js";

export const MASK = "••••••••";

export type ConnectionKind = "direct" | "session" | "transaction";

const LABELS: Record<ConnectionKind, string> = {
  direct: "Direct",
  session: "Session pooler",
  transaction: "Transaction pooler",
};

export type ProjectEndpoint = Pick<
  Box,
  | "host"
  | "adminUser"
  | "publicHost"
  | "publicPort"
  | "sslmode"
  | "poolerTenant"
  | "poolerSessionPort"
  | "poolerTransactionPort"
>;

export interface ConnectionString {
  kind: ConnectionKind;
  label: string;
  url: string;
  masked: string;
}

export function ownerConnectionStrings(
  box: ProjectEndpoint & Pick<Box, "kind">,
  project: Pick<Project, "dbName" | "ownerRole" | "kind">,
  password: string,
  poolerHost: string,
): ConnectionString[] {
  const build = (
    kind: ConnectionKind,
    user: string,
    host: string,
    port: number,
    query = "",
  ): ConnectionString => {
    const url = (secret: string) =>
      `postgresql://${user}:${secret}@${host}:${port}/${project.dbName}${query}`;
    return { kind, label: LABELS[kind], url: url(encodeURIComponent(password)), masked: url(MASK) };
  };
  // A box hattisar reaches over TLS (a cloud provider) usually refuses clients without it.
  const tls = box.sslmode === "disable" ? "" : `?sslmode=${box.sslmode}`;
  const attached = isAttached(project);
  const direct = build(
    "direct",
    attached ? project.ownerRole : ownerLogin(box, project.ownerRole),
    box.publicHost,
    box.publicPort,
    tls,
  );
  // An attached login has no tenant of its own on hattisar's pooler.
  if (attached) return [direct];
  const { poolerTenant, poolerSessionPort, poolerTransactionPort } = box;
  if (poolerTenant === null || poolerSessionPort === null || poolerTransactionPort === null) {
    return [direct];
  }
  const user = `${project.ownerRole}.${poolerTenant}`;
  const pooled = [
    build("session", user, poolerHost, poolerSessionPort),
    build("transaction", user, poolerHost, poolerTransactionPort),
  ];
  // The shared box's db publishes no port.
  return box.kind === "shared" ? pooled : [...pooled, direct];
}
