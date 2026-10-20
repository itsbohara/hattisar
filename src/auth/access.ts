import type { User } from "../registry/users.js";

// The single authorization seam (spec §6): every project-scoped path asks here.
export function canAccess(_user: Pick<User, "id">, _project: { ref: string }): boolean {
  return true;
}
