import { listBackups } from "../registry/backups.js";
import type { Registry } from "../registry/db.js";
import { getProjectById, type Project, type ProjectStatus } from "../registry/projects.js";

export interface ProjectOperation {
  action: string;
  holds: string;
  status: ProjectStatus;
}

// What holds each project, by id. In memory because hattisar is one process over one SQLite
// registry: a second replica would not see these and could change a project under this one. A
// restart kills the operations along with their entries.
const held = new Map<number, string>();

// Deleting, purging or re-keying the project under a running pg_dump or pg_restore would break it.
export function busyReason(db: Registry, project: Project): string | undefined {
  const holder = held.get(project.id);
  if (holder !== undefined) return holder;
  if (listBackups(db, project.id).some((backup) => backup.status === "running")) {
    return "a backup of it is running";
  }
  return undefined;
}

export function busyProblem(db: Registry, project: Project, action: string): string | undefined {
  const reason = busyReason(db, project);
  if (reason === undefined) return undefined;
  return `Can't ${action} ${project.ref} while ${reason}. Try again when it finishes.`;
}

export type ProjectHold = { ok: true; release: () => void } | { ok: false; problem: string };

// For work that outlives the request holding it, such as a streamed dump. The caller must call
// release once that work ends, or the project stays busy until hattisar restarts.
export function holdProject(
  db: Registry,
  project: Project,
  operation: Omit<ProjectOperation, "status">,
): ProjectHold {
  const busy = busyProblem(db, project, operation.action);
  if (busy !== undefined) return { ok: false, problem: busy };
  held.set(project.id, operation.holds);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      held.delete(project.id);
    },
  };
}

// The busy check, the take and the re-read are synchronous, so no other request can slip between
// them. The re-read catches a project that changed while this request was on its way here.
export async function holdingProject<T>(
  db: Registry,
  project: Project,
  operation: ProjectOperation,
  run: (current: Project) => Promise<T>,
): Promise<T | { ok: false; problem: string }> {
  const busy = busyProblem(db, project, operation.action);
  if (busy !== undefined) return { ok: false, problem: busy };
  held.set(project.id, operation.holds);
  try {
    const current = getProjectById(db, project.id);
    if (current?.status !== operation.status) {
      const now = current === undefined ? "no longer exists" : `is ${current.status} now`;
      return { ok: false, problem: `Can't ${operation.action} ${project.ref}: it ${now}.` };
    }
    return await run(current);
  } finally {
    held.delete(project.id);
  }
}
