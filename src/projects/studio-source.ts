import { type Box, getBoxById, listBoxes } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { getProjectByRef, listProjects, type Project } from "../registry/projects.js";
import { decryptSecret } from "../registry/secrets.js";
import type { ProjectSource, Project as StudioProject } from "../studio/projects-source.js";

// Only active projects exist for Studio: a deleted one answers like an unknown ref.
export class RegistryProjectSource implements ProjectSource {
  constructor(
    private readonly db: Registry,
    private readonly secretKey: Buffer,
  ) {}

  async list(_user: string): Promise<StudioProject[]> {
    const boxes = new Map(listBoxes(this.db).map((box) => [box.id, box]));
    return listProjects(this.db, "active").flatMap((project) => {
      const box = boxes.get(project.boxId);
      return box ? [this.toStudio(project, box)] : [];
    });
  }

  async get(_user: string, ref: string): Promise<StudioProject | undefined> {
    const project = getProjectByRef(this.db, ref);
    if (project?.status !== "active") return undefined;
    const box = getBoxById(this.db, project.boxId);
    return box && this.toStudio(project, box);
  }

  private toStudio(project: Project, box: Box): StudioProject {
    return {
      id: project.id,
      ref: project.ref,
      name: project.name,
      dbName: project.dbName,
      ownerRole: project.ownerRole,
      boxName: box.name,
      box: {
        host: box.host,
        port: box.port,
        adminUser: box.adminUser,
        adminPassword: decryptSecret(box.adminPasswordEnc, this.secretKey),
        sslmode: box.sslmode,
        publicHost: box.publicHost,
        publicPort: box.publicPort,
      },
      insertedAt: project.createdAt,
    };
  }
}
