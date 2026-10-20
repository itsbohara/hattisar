const REF_PATTERN = /^[a-z][a-z0-9-]{2,39}$/;
// /_hs/projects/new is the new-project form, so a project with this ref would be unreachable.
const RESERVED_REFS = new Set(["new"]);

export function refProblem(ref: string): string | undefined {
  if (!REF_PATTERN.test(ref)) {
    return "Ref must be 3-40 characters: lowercase letters, digits and hyphens, starting with a letter";
  }
  if (RESERVED_REFS.has(ref)) return `Ref "${ref}" is reserved`;
  return undefined;
}

// Only valid for a ref that passed refProblem: the result is an identifier, never a quoted one.
export function dbNameFor(ref: string): string {
  return ref.replaceAll("-", "_");
}

export function ownerRoleFor(dbName: string): string {
  return `hs_${dbName}_owner`;
}

export function deletedDbNameFor(dbName: string, at: Date, taken: Iterable<string>): string {
  const base = `${dbName}__deleted_${at.toISOString().slice(0, 10).replaceAll("-", "")}`;
  const names = new Set(taken);
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

// Serialised into the new-project page's inline script: it must stay self-contained.
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
