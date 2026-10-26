import { ownerLogin } from "../boxes/owner-login.js";
import { type Box, getBoxById, listBoxes } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { getProjectByRef, listProjects, type Project } from "../registry/projects.js";
import { decryptSecret, SecretError } from "../registry/secrets.js";
import {
  type ProjectSource,
  type ProjectSummary,
  type Project as StudioProject,
  UnreadableSecretError,
} from "../studio/projects-source.js";
import { isAttached } from "./attach.js";

// Only active projects exist for Studio: a deleted one answers like an unknown ref.
export class RegistryProjectSource implements ProjectSource {
  constructor(
    private readonly db: Registry,
    private readonly secretKey: Buffer,
  ) {}

  async list(_user: string): Promise<ProjectSummary[]> {
    const boxes = new Map(listBoxes(this.db).map((box) => [box.id, box]));
    return listProjects(this.db, "active").flatMap((project) => {
      const box = boxes.get(project.boxId);
      return box ? [toSummary(project, box)] : [];
    });
  }

  async get(_user: string, ref: string): Promise<StudioProject | undefined> {
    const project = getProjectByRef(this.db, ref);
    if (project?.status !== "active") return undefined;
    const box = getBoxById(this.db, project.boxId);
    return box && { ...toSummary(project, box), ownerPassword: () => this.decrypt(project) };
  }

  private decrypt(project: Project): string {
    try {
      return decryptSecret(project.ownerPasswordEnc, this.secretKey);
    } catch (error) {
      if (!(error instanceof SecretError)) throw error;
      throw new UnreadableSecretError(
        isAttached(project)
          ? `The login password of project ${project.ref} cannot be decrypted. Update its login on its hattisar project page.`
          : `The owner password of project ${project.ref} cannot be decrypted. Rotate it on its hattisar project page.`,
      );
    }
  }
}

function toSummary(project: Project, box: Box): ProjectSummary {
  return {
    id: project.id,
    ref: project.ref,
    name: project.name,
    dbName: project.dbName,
    // Studio uses this only to log in and to show as db_user, so it is the login name.
    ownerRole: isAttached(project) ? project.ownerRole : ownerLogin(box, project.ownerRole),
    boxName: box.name,
    box: {
      host: box.host,
      port: box.port,
      sslmode: box.sslmode,
      publicHost: box.publicHost,
      publicPort: box.publicPort,
    },
    insertedAt: project.createdAt,
  };
}
