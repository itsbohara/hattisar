export interface Box {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
}

export interface Project {
  id: number;
  ref: string;
  name: string;
  dbName: string;
  boxName: string;
  box: Box;
  insertedAt: string;
}

export interface ProjectSource {
  list(user: string): Promise<Project[]>;
  get(user: string, ref: string): Promise<Project | undefined>;
}

export type SpikeProject = Omit<Project, "id" | "insertedAt">;

const SPIKE_INSERTED_AT = "2026-10-20T00:00:00.000Z";

export class SpikeProjectSource implements ProjectSource {
  private readonly projects: readonly Project[];

  constructor(projects: readonly SpikeProject[]) {
    this.projects = projects.map((project, index) => ({
      ...project,
      id: index + 1,
      insertedAt: SPIKE_INSERTED_AT,
    }));
  }

  async list(_user: string): Promise<Project[]> {
    return [...this.projects];
  }

  async get(_user: string, ref: string): Promise<Project | undefined> {
    return this.projects.find((project) => project.ref === ref);
  }
}
