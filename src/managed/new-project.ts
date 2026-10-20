import {
  type CreateResult,
  createProject,
  type ProjectServiceDeps,
  projectFieldProblems,
} from "../projects/service.js";
import type { ManagedBoxes } from "./service.js";

// The New-project form's "New dedicated box": a managed box named after the ref, then the project
// on it. A failed project create removes the box again, since nothing else uses it.
export async function createProjectOnNewBox(
  deps: ProjectServiceDeps,
  managed: ManagedBoxes,
  form: { name: string; ref: string },
): Promise<CreateResult> {
  const problems = projectFieldProblems(deps.db, form);
  if (problems.length > 0) return { ok: false, problems };
  const created = await managed.create(form.ref);
  if (!created.ok) return created;
  const result = await createProject(deps, { ...form, boxId: created.box.id });
  if (result.ok) return result;
  const removed = await managed.remove(created.box);
  return removed.ok ? result : { ok: false, problems: [...result.problems, removed.problem] };
}
