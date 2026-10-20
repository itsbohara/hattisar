export interface Box {
  host: string;
  port: number;
  sslmode: string;
  publicHost: string;
  publicPort: number;
}

export interface ProjectSummary {
  id: number;
  ref: string;
  name: string;
  dbName: string;
  ownerRole: string;
  boxName: string;
  box: Box;
  insertedAt: string;
}

// Only connecting needs the password, so it is decrypted on demand: a project whose secret will
// not decrypt still answers every route that does not open a connection.
export interface Project extends ProjectSummary {
  ownerPassword(): string;
}

export class UnreadableSecretError extends Error {
  override name = "UnreadableSecretError";
}

export interface ProjectSource {
  list(user: string): Promise<ProjectSummary[]>;
  get(user: string, ref: string): Promise<Project | undefined>;
}
