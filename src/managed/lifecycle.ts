import type { LifecycleHook } from "../projects/service.js";
import type { Box } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { listProjectsOnBox } from "../registry/projects.js";
import { dockerMessage } from "./docker.js";
import type { ManagedBoxes } from "./service.js";

function hasActiveProject(db: Registry, box: Box): boolean {
  return listProjectsOnBox(db, box.id).some((project) => project.status === "active");
}

// §10: a managed box with no active project is stopped, restore starts it again, and purging its
// last project removes the box. "purging" still sees the project's own row.
export function managedLifecycle(db: Registry, managed: ManagedBoxes): LifecycleHook {
  return async (box, project, event) => {
    if (box.kind !== "managed") return undefined;
    switch (event) {
      case "deleted":
        if (hasActiveProject(db, box)) return undefined;
        // The delete itself succeeded; a box left running is only wasted memory.
        await managed.stop(box).catch((error: unknown) => {
          console.error(
            `hattisar: stopping box ${box.name} after deleting ${project.ref} failed: ${dockerMessage(error)}`,
          );
        });
        return undefined;
      case "restoring":
        await managed.start(box);
        return undefined;
      case "purging":
        if (listProjectsOnBox(db, box.id).length === 1) return "skip-sql";
        await managed.start(box);
        return undefined;
      case "purged": {
        if (listProjectsOnBox(db, box.id).length === 0) {
          const result = await managed.remove(box);
          if (!result.ok) throw new Error(result.problem);
        } else if (!hasActiveProject(db, box)) {
          await managed.stop(box);
        }
        return undefined;
      }
    }
  };
}
