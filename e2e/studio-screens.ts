// Studio pages that read the project's database. Paths are those of the pinned Studio image (§12):
// policies live under database/ (auth/policies redirects there) and advisors has no index page.
export const STUDIO_SCREENS = [
  "editor",
  "sql/new",
  "database/tables",
  "database/functions",
  "database/triggers",
  "database/extensions",
  "database/roles",
  "database/policies",
  "database/publications",
  "database/indexes",
  "database/types",
  "database/schemas",
  // These three make no pg-meta calls in the pinned Studio: kept for the API inventory, not as
  // routing proof.
  "settings/general",
  "advisors/security",
  "advisors/performance",
] as const;

export function studioScreenPaths(ref: string): string[] {
  return STUDIO_SCREENS.map((screen) => `/project/${ref}/${screen}`);
}
