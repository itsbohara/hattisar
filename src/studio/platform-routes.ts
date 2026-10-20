import type { Project } from "./projects-source.js";

export const AI_DISABLED_BODY = { error: { message: "AI features are disabled in hattisar" } };

export function studioProject(project: Project) {
  return {
    id: project.id,
    ref: project.ref,
    name: project.name,
    organization_id: 1,
    cloud_provider: "localhost",
    status: "ACTIVE_HEALTHY",
    region: project.boxName,
    inserted_at: project.insertedAt,
  };
}

export function studioProjectDetail(project: Project) {
  return { ...studioProject(project), connectionString: "", restUrl: "" };
}
