export interface Box {
  host: string;
  port: number;
  sslmode: string;
  publicHost: string;
  publicPort: number;
}

export interface Project {
  id: number;
  ref: string;
  name: string;
  dbName: string;
  ownerRole: string;
  ownerPassword: string;
  boxName: string;
  box: Box;
  insertedAt: string;
}

export interface ProjectSource {
  list(user: string): Promise<Project[]>;
  get(user: string, ref: string): Promise<Project | undefined>;
}
