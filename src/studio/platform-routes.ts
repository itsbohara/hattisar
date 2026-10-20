import type { ProjectSummary } from "./projects-source.js";

export const AI_DISABLED_BODY = { error: { message: "AI features are disabled in hattisar" } };
export const NOT_AVAILABLE_BODY = { error: { message: "Not available in hattisar" } };
export const SETTINGS_UNAVAILABLE_BODY = { message: "Studio's project settings are unavailable" };

const SSL_REQUIRED = new Set(["require", "verify-ca", "verify-full"]);

export function studioProject(project: ProjectSummary) {
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

export function studioProjectDetail(project: ProjectSummary) {
  return { ...studioProject(project), connectionString: "", restUrl: "" };
}

export function studioDatabases(project: ProjectSummary) {
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

// Only the project's identity and connection: the rest of the stub is whatever shape this Studio
// version expects.
export function studioSettings(project: ProjectSummary, stub: Record<string, unknown>) {
  return {
    ...stub,
    ref: project.ref,
    name: project.name,
    db_host: project.box.publicHost,
    db_name: project.dbName,
    db_port: project.box.publicPort,
    db_user: project.ownerRole,
    ...(SSL_REQUIRED.has(project.box.sslmode) && { ssl_enforced: true }),
  };
}
