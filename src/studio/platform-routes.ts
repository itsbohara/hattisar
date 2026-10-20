import type { Project } from "./projects-source.js";

export const AI_DISABLED_BODY = { error: { message: "AI features are disabled in hattisar" } };
export const NOT_AVAILABLE_BODY = { error: { message: "Not available in hattisar" } };

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

export function studioDatabases(project: Project) {
  return [
    {
      cloud_provider: "localhost",
      connectionString: "",
      connection_string_read_only: "",
      db_host: project.box.publicHost,
      db_name: project.dbName,
      db_port: project.box.publicPort,
      db_user: project.ownerRole,
      identifier: project.ref,
      inserted_at: "",
      region: "local",
      restUrl: "",
      size: "",
      status: "ACTIVE_HEALTHY",
    },
  ];
}
