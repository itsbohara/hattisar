# Plan: Settings page with section navigation

Spec: `docs/design.md` (binding where it describes settings routes).

## Global constraints

- Server-rendered JSX pages and plain CSS (`src/ui/static/app.css`), no client framework. Reuse the
  existing tokens, classes and components; add CSS only where the existing classes cannot express
  the layout.
- Unit tests in `test/unit` (vitest). Run `pnpm test`, `pnpm typecheck`, `pnpm lint`.
- No `pnpm test:it`, `pnpm test:e2e` or docker: the developer is using the dev stack. CI runs them.
  Update any integration or e2e test that asserts the old `/_hs/settings` markup or flow, and say so.
- Do not commit.

## Task 1: Split Settings into Account and Backup storage sections

**Problem.** `/_hs/settings` stacks "Change password" and "Backup storage (S3)" as touching cards in
one long column, not aligned with the nav, and gives no sign of whether storage is set up.

**Ruling.**
- Routes: `GET /_hs/settings` redirects (302) to `/_hs/settings/storage`.
  `GET /_hs/settings/account` renders the password form, `GET /_hs/settings/storage` the S3 form.
  The existing POST endpoints keep their paths (`/_hs/settings/password`, `/_hs/settings/s3`,
  `/_hs/settings/s3/test`) and re-render the section they belong to, with the same notices as today.
- Layout: a left section nav (Account, Backup storage) beside the section's content. The current
  section is marked (`aria-current="page"`). Below roughly 720px the nav stacks above the content
  as a horizontal row. The content column lines up with the page's main column under the top nav.
- Account section: shows the signed-in username as context, then the existing change-password
  form unchanged in behaviour.
- Backup storage section:
  - A status line at the top: "Configured · bucket `<bucket>`" (with endpoint host when set) when
    S3 settings are saved, else "Not configured — backups and restores need this." No persisted
    last-test time.
  - Fields in a two-column grid on wide screens: Endpoint | Region, Bucket | Key prefix,
    Access key ID | Secret access key; the path-style checkbox on its own row. One column on narrow
    screens. Hints stay with their fields.
  - Actions row: "Test connection" (quiet) on the left, "Save" (primary) on the right. Same
    `formaction` behaviour as today.
- Cards that do stack anywhere get a consistent gap between them.
- Update `docs/design.md` where it lists the settings routes.

**Tests.** Unit tests: the redirect; each section renders with its nav item current and without
the other section's form; the POSTs re-render the right section with their notices (password error
and saved, S3 problems, saved, test ok/failed); status line for configured and not configured.

**Visual check.** Write a throwaway script outside `src/` (in the scratch path the controller
gives you) that builds the app the way the unit tests do, fetches both sections (S3 configured and
not, plus one with an error notice), inlines `app.css`, and writes standalone HTML files there.
Do not commit the script. Report the file paths.
