import type { ConnectionString } from "../../projects/connection-strings.js";
import { slugify } from "../../projects/naming.js";
import type { Backup, BackupSchedule } from "../../registry/backups.js";
import type { Box } from "../../registry/boxes.js";
import type { Project } from "../../registry/projects.js";
import { Layout } from "../layout.js";
import { ConfirmRefInput, utc } from "./trash.js";

export const DEV_ONLY_WARNING =
  "Best for development only — shares one Postgres with other projects";

export interface ProjectRow {
  project: Project;
  box: Box;
  busy: boolean;
}

export interface BoxSummary {
  box: Box;
  projectCount: number;
}

export type ProjectView = "grid" | "list";
export type ProjectSort = "name" | "created";

export interface ProjectsQuery {
  view: ProjectView;
  q: string;
  sort: ProjectSort;
}

export const USAGE_PATH = "/_hs/usage";

function studioHref(ref: string): string {
  return `/project/${ref}/editor`;
}

export function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <div class="alert alert-error" role="alert">
      <ul class="problems">
        {problems.map((problem) => (
          <li>{problem}</li>
        ))}
      </ul>
    </div>
  );
}

function projectsHref(query: ProjectsQuery, change: Partial<ProjectsQuery>): string {
  const { view, q, sort } = { ...query, ...change };
  const params = new URLSearchParams({ view });
  if (q !== "") params.set("q", q);
  if (sort !== "name") params.set("sort", sort);
  return `/_hs/projects?${params}`;
}

function createdDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function StatusBadge({ busy }: { busy: boolean }) {
  return busy ? <span class="pill pill-busy">Busy</span> : <span class="pill pill-ok">Active</span>;
}

function KindBadge({ box }: { box: Box }) {
  return <span class="pill">{box.devOnly ? `${box.kind} · dev` : box.kind}</span>;
}

// Filled in from USAGE_PATH by USAGE_SCRIPT once the page has loaded.
function Size({ ref }: { ref: string }) {
  return (
    <span class="size" data-size-of={ref}>
      …
    </span>
  );
}

function ProjectMenu({ project }: { project: Project }) {
  return (
    <details class="menu project-menu" data-menu>
      <summary class="icon-button" aria-label={`Actions for ${project.name}`}>
        ⋮
      </summary>
      <div class="menu-panel menu-panel-right">
        <a class="menu-item" href={studioHref(project.ref)}>
          Open in Studio
        </a>
        <a class="menu-item" href={`/_hs/projects/${project.ref}`}>
          Project settings
        </a>
        <a class="menu-item menu-item-danger" href={`/_hs/projects/${project.ref}#delete`}>
          Delete…
        </a>
      </div>
    </details>
  );
}

function searchText(project: Project): string {
  return `${project.name} ${project.ref}`.toLowerCase();
}

// Every project is rendered and the search only hides, so clearing it needs no reload.
function hiddenBy(project: Project, q: string): boolean {
  return !searchText(project).includes(q.toLowerCase());
}

function ProjectCards({ rows, q }: { rows: ProjectRow[]; q: string }) {
  return (
    <ul class="project-grid">
      {rows.map(({ project, box, busy }) => (
        <li
          class="project-card"
          data-project={project.ref}
          data-search={searchText(project)}
          hidden={hiddenBy(project, q)}
        >
          <div class="project-card-head">
            <div class="project-title">
              <a class="project-link" href={studioHref(project.ref)}>
                {project.name}
              </a>
              <code class="project-ref">{project.ref}</code>
            </div>
            <ProjectMenu project={project} />
          </div>
          <div class="pills">
            <StatusBadge busy={busy} />
            <KindBadge box={box} />
          </div>
          <dl class="project-meta">
            <div>
              <dt>Box</dt>
              <dd>{box.name}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>
                <Size ref={project.ref} />
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{createdDate(project.createdAt)}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function SortHeader({
  query,
  sort,
  label,
  optional = false,
}: {
  query: ProjectsQuery;
  sort: ProjectSort;
  label: string;
  optional?: boolean;
}) {
  const active = query.sort === sort;
  return (
    <th
      class={optional ? "col-optional" : undefined}
      aria-sort={active ? (sort === "name" ? "ascending" : "descending") : undefined}
    >
      <a class="sort-link" href={projectsHref(query, { sort })}>
        {label}
        {active && <span aria-hidden="true">{sort === "name" ? " ↑" : " ↓"}</span>}
      </a>
    </th>
  );
}

function ProjectTable({ rows, query }: { rows: ProjectRow[]; query: ProjectsQuery }) {
  return (
    <div class="table-frame">
      <table class="table project-table">
        <thead>
          <tr>
            <SortHeader query={query} sort="name" label="Project" />
            <th>Status</th>
            <th class="col-optional">Kind</th>
            <th class="col-optional">Box</th>
            <th class="col-optional">Size</th>
            <SortHeader query={query} sort="created" label="Created" optional />
            <th>
              <span class="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ project, box, busy }) => (
            <tr
              data-project={project.ref}
              data-search={searchText(project)}
              hidden={hiddenBy(project, query.q)}
            >
              <td>
                <a class="project-link" href={studioHref(project.ref)}>
                  {project.name}
                </a>
                <code class="project-ref">{project.ref}</code>
              </td>
              <td>
                <StatusBadge busy={busy} />
              </td>
              <td class="col-optional">
                <KindBadge box={box} />
              </td>
              <td class="col-optional">{box.name}</td>
              <td class="col-optional">
                <Size ref={project.ref} />
              </td>
              <td class="col-optional">{createdDate(project.createdAt)}</td>
              <td class="cell-actions">
                <ProjectMenu project={project} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoxesPanel({ boxes }: { boxes: BoxSummary[] }) {
  return (
    <aside class="boxes-panel" aria-labelledby="boxes-panel-title">
      <div class="boxes-panel-head">
        <h2 id="boxes-panel-title">Boxes</h2>
        <a class="link-quiet" href="/_hs/boxes">
          Manage
        </a>
      </div>
      <ul class="box-usage">
        {boxes.map(({ box, projectCount }) => (
          <li data-box={box.id} data-projects={projectCount}>
            <span class="box-dot" aria-hidden="true" />
            <span class="box-usage-name">
              {box.name}
              <small>
                {projectCount === 1 ? "1 project" : `${projectCount} projects`}
                <span class="box-state" data-box-state={box.id} />
              </small>
            </span>
            <span class="size" data-size-of-box={box.id}>
              {projectCount === 0 ? "—" : "…"}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ViewToggle({ query }: { query: ProjectsQuery }) {
  return (
    <nav class="segmented" aria-label="View">
      {(["grid", "list"] as const).map((view) => (
        <a
          class="segmented-item"
          href={projectsHref(query, { view })}
          aria-current={query.view === view ? "true" : undefined}
          title={view === "grid" ? "Grid view" : "List view"}
        >
          {view === "grid" ? "Grid" : "List"}
        </a>
      ))}
    </nav>
  );
}

function Toolbar({ query, deletedCount }: { query: ProjectsQuery; deletedCount: number }) {
  return (
    <div class="toolbar">
      <form method="get" action="/_hs/projects" class="toolbar-search">
        <input type="hidden" name="view" value={query.view} />
        {query.sort !== "name" && <input type="hidden" name="sort" value={query.sort} />}
        <input
          type="search"
          name="q"
          value={query.q}
          placeholder="Search for a project"
          aria-label="Search for a project"
          id="project-search"
        />
      </form>
      <nav class="segmented" aria-label="Sort">
        <a
          class="segmented-item"
          href={projectsHref(query, { sort: "name" })}
          aria-current={query.sort === "name" ? "true" : undefined}
        >
          Name
        </a>
        <a
          class="segmented-item"
          href={projectsHref(query, { sort: "created" })}
          aria-current={query.sort === "created" ? "true" : undefined}
        >
          Newest
        </a>
      </nav>
      <span class="toolbar-gap" />
      <a class="link-quiet" href="/_hs/trash">
        Trash ({deletedCount})
      </a>
      <ViewToggle query={query} />
      <a class="button" href="/_hs/projects/new">
        New project
      </a>
    </div>
  );
}

// Keeps ?q= in the URL so a reload or a shared link shows the same search.
const SEARCH_SCRIPT = `(() => {
  const input = document.getElementById("project-search");
  const empty = document.getElementById("no-matches");
  if (!input) return;
  input.addEventListener("input", () => {
    const needle = input.value.trim().toLowerCase();
    let shown = 0;
    for (const item of document.querySelectorAll("[data-search]")) {
      item.hidden = !item.dataset.search.includes(needle);
      if (!item.hidden) shown += 1;
    }
    if (empty) empty.hidden = shown > 0;
    const url = new URL(location.href);
    if (needle === "") url.searchParams.delete("q");
    else url.searchParams.set("q", input.value.trim());
    history.replaceState(history.state, "", url);
  });
})();`;

const USAGE_SCRIPT = `(() => {
  const units = ["B", "kB", "MB", "GB", "TB"];
  const format = (bytes) => {
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit += 1;
    }
    return (unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
  };
  const fill = (selector, text) => {
    for (const element of document.querySelectorAll(selector)) element.textContent = text;
  };
  fetch(${JSON.stringify(USAGE_PATH)}, { headers: { accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
    .then(({ boxes, projects }) => {
      for (const element of document.querySelectorAll("[data-size-of]")) {
        const bytes = projects[element.dataset.sizeOf];
        element.textContent = bytes === undefined ? "—" : format(bytes);
      }
      for (const [id, box] of Object.entries(boxes)) {
        fill('[data-size-of-box="' + id + '"]', box.reachable ? format(box.bytes) : "—");
        fill('[data-box-state="' + id + '"]', box.reachable ? "" : " · unreachable");
        document.querySelector('[data-box="' + id + '"]')
          ?.setAttribute("data-reachable", String(box.reachable));
      }
    })
    .catch(() => fill("[data-size-of]", "—"));
})();`;

export function ProjectsPage({
  rows,
  boxes,
  deletedCount,
  query,
}: {
  rows: ProjectRow[];
  boxes: BoxSummary[];
  deletedCount: number;
  query: ProjectsQuery;
}) {
  return (
    <Layout title="Projects" section="projects" wide>
      <h1>Projects</h1>
      <div class="projects-layout">
        <div class="projects-main">
          <Toolbar query={query} deletedCount={deletedCount} />
          {rows.length === 0 ? (
            <div class="empty">
              <p>No projects yet.</p>
              <a class="button" href="/_hs/projects/new">
                Create your first project
              </a>
            </div>
          ) : (
            <>
              {query.view === "grid" ? (
                <ProjectCards rows={rows} q={query.q} />
              ) : (
                <ProjectTable rows={rows} query={query} />
              )}
              <p
                class="empty"
                id="no-matches"
                hidden={rows.some(({ project }) => !hiddenBy(project, query.q))}
              >
                No projects match your search.
              </p>
            </>
          )}
        </div>
        <BoxesPanel boxes={boxes} />
      </div>
      <script dangerouslySetInnerHTML={{ __html: SEARCH_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: USAGE_SCRIPT }} />
    </Layout>
  );
}

export interface NewProjectValues {
  name: string;
  ref: string;
  boxId: number | undefined;
  newBox?: boolean;
}

export const NEW_BOX_OPTION = "new";

// The ref follows the name until the user types into it.
export function slugScript(formId: string): string {
  return `(() => {
  const slugify = ${slugify.toString()};
  const form = document.getElementById(${JSON.stringify(formId)});
  const name = form.elements.name;
  const ref = form.elements.ref;
  let edited = ref.value !== "";
  name.addEventListener("input", () => {
    if (!edited) ref.value = slugify(name.value);
  });
  ref.addEventListener("input", () => {
    edited = ref.value !== "";
  });
})();`;
}

// Name, ref and box: the fields of every form that creates a project.
export function ProjectFields({
  boxes,
  values,
  offerNewBox = false,
}: {
  boxes: Box[];
  values: NewProjectValues;
  offerNewBox?: boolean;
}) {
  return (
    <>
      <label class="field">
        <span>Name</span>
        <input name="name" required maxlength={100} value={values.name} />
      </label>
      <label class="field">
        <span>Ref</span>
        <input name="ref" required pattern="[a-z][a-z0-9\-]{2,39}" value={values.ref} />
        <small class="hint">
          Lowercase letters, digits and hyphens; 3–40 characters. Names the database and can't be
          changed later.
        </small>
      </label>
      <label class="field">
        <span>Box</span>
        <select name="boxId">
          {boxes.map((box) => (
            <option value={String(box.id)} selected={box.id === values.boxId}>
              {box.devOnly ? `${box.name} — ${DEV_ONLY_WARNING}` : box.name}
            </option>
          ))}
          {offerNewBox && (
            <option value={NEW_BOX_OPTION} selected={values.newBox === true}>
              New dedicated box — its own Postgres container, named after the ref
            </option>
          )}
        </select>
        {offerNewBox && <small class="hint">Starting a new box can take a minute or two.</small>}
      </label>
    </>
  );
}

export function NewProjectPage({
  boxes,
  values,
  problems = [],
  offerNewBox = false,
}: {
  boxes: Box[];
  values: NewProjectValues;
  problems?: string[];
  offerNewBox?: boolean;
}) {
  return (
    <Layout title="New project" section="projects">
      <h1>New project</h1>
      <section class="card card-roomy">
        <form method="post" action="/_hs/projects" class="form" id="new-project">
          <Problems problems={problems} />
          <ProjectFields boxes={boxes} values={values} offerNewBox={offerNewBox} />
          <div class="form-actions">
            <button type="submit" class="button">
              Create project
            </button>
            <a class="button-quiet" href="/_hs/projects">
              Cancel
            </a>
          </div>
        </form>
      </section>
      <script dangerouslySetInnerHTML={{ __html: slugScript("new-project") }} />
    </Layout>
  );
}

const CREDENTIALS_SCRIPT = `document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-secret-action]");
  if (!button) return;
  const code = document.getElementById(button.dataset.target);
  if (button.dataset.secretAction === "reveal") {
    const shown = code.textContent === code.dataset.url;
    code.textContent = shown ? code.dataset.masked : code.dataset.url;
    button.textContent = shown ? "Reveal" : "Hide";
    return;
  }
  navigator.clipboard.writeText(code.dataset.url).then(() => {
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1500);
  });
});`;

function ConnectionStrings({ strings }: { strings: ConnectionString[] }) {
  return (
    <div class="connection-strings">
      {strings.map((string, index) => (
        <div class="connection-string">
          <span class="connection-label">{string.label}</span>
          <code id={`conn-${index}`} data-url={string.url} data-masked={string.masked}>
            {string.masked}
          </code>
          <div class="row-actions">
            <button
              type="button"
              class="button-quiet"
              data-secret-action="reveal"
              data-target={`conn-${index}`}
            >
              Reveal
            </button>
            <button
              type="button"
              class="button-quiet"
              data-secret-action="copy"
              data-target={`conn-${index}`}
            >
              Copy
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

function BackupStatus({ backup }: { backup: Backup }) {
  if (backup.status !== "failed") return <>{backup.status}</>;
  return (
    <>
      <span class="status-failed">failed</span>
      {backup.error && <small class="hint backup-error">{backup.error}</small>}
    </>
  );
}

const FREQUENCIES = ["off", "daily", "weekly"] as const;

function hourLabel(hourUtc: number): string {
  return `${String(hourUtc).padStart(2, "0")}:00 UTC`;
}

function BackupScheduleForm({
  base,
  schedule,
  backupHourUtc,
}: {
  base: string;
  schedule: BackupSchedule;
  backupHourUtc: number;
}) {
  return (
    <form method="post" action={`${base}/schedule`} class="form-inline backup-schedule">
      <label class="field">
        <span>Schedule</span>
        <select name="frequency">
          {FREQUENCIES.map((frequency) => (
            <option value={frequency} selected={frequency === schedule.frequency}>
              {frequency}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span>Keep daily</span>
        <input
          name="keepDaily"
          type="number"
          required
          min={1}
          max={1000}
          value={String(schedule.keepDaily)}
        />
      </label>
      <label class="field">
        <span>Keep weekly</span>
        <input
          name="keepWeekly"
          type="number"
          required
          min={0}
          max={1000}
          value={String(schedule.keepWeekly)}
        />
      </label>
      <button type="submit" class="button-quiet">
        Save schedule
      </button>
      <small class="hint">
        Daily backups run at {hourLabel(backupHourUtc)}, weekly ones on Mondays at that hour. Of the
        scheduled backups, the newest "keep daily" are kept, then the newest of each older week up
        to "keep weekly" weeks. Manual backups are kept until deleted.
      </small>
    </form>
  );
}

function Backups({
  base,
  backups,
  schedule,
  backupHourUtc,
  s3Configured,
}: {
  base: string;
  backups: Backup[];
  schedule: BackupSchedule;
  backupHourUtc: number;
  s3Configured: boolean;
}) {
  return (
    <section class="card card-wide">
      <h2>Backups</h2>
      <div class="form-inline">
        <a class="button-quiet" href={`${base}/dump`}>
          Download dump
        </a>
        <form method="post" action={`${base}/backups`}>
          <button type="submit" class="button" disabled={!s3Configured}>
            Back up now
          </button>
        </form>
      </div>
      <p class="hint">
        {s3Configured ? (
          "Backups are pg_dump archives: a restore returns the database to when the dump was taken, not to any point in time."
        ) : (
          <>
            Configure S3 storage in <a href="/_hs/settings/storage">Settings</a> to keep backups.
          </>
        )}
      </p>
      <BackupScheduleForm base={base} schedule={schedule} backupHourUtc={backupHourUtc} />
      {backups.length > 0 && (
        <table class="table">
          <thead>
            <tr>
              <th>Taken</th>
              <th class="col-optional">Kind</th>
              <th class="col-optional">Size</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {backups.map((backup) => (
              <tr data-backup={String(backup.id)}>
                <td>{utc(new Date(backup.createdAt))}</td>
                <td>{backup.kind}</td>
                <td>{backup.sizeBytes === null ? "" : formatBytes(backup.sizeBytes)}</td>
                <td>
                  <BackupStatus backup={backup} />
                </td>
                <td class="row-actions">
                  {backup.status === "done" && (
                    <a class="button-quiet" href={`${base}/backups/${backup.id}/restore`}>
                      Restore…
                    </a>
                  )}
                  {backup.status !== "running" && (
                    <form method="post" action={`${base}/backups/${backup.id}/delete`}>
                      <button type="submit" class="button-quiet button-danger">
                        Delete
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export interface ProjectPageNotice {
  kind: "ok" | "error";
  message: string;
}

export function ProjectPage({
  project,
  box,
  strings,
  backups,
  schedule,
  backupHourUtc,
  s3Configured,
  notice,
}: {
  project: Project;
  box: Box;
  strings: ConnectionString[] | undefined;
  backups: Backup[];
  schedule: BackupSchedule;
  backupHourUtc: number;
  s3Configured: boolean;
  notice?: ProjectPageNotice;
}) {
  const base = `/_hs/projects/${project.ref}`;
  return (
    <Layout title={project.name} section="projects">
      <div class="page-head">
        <h1>{project.name}</h1>
        <a class="button" href={studioHref(project.ref)}>
          Open in Studio
        </a>
      </div>
      {notice && (
        <p
          class={`alert ${notice.kind === "ok" ? "alert-ok" : "alert-error"}`}
          role={notice.kind === "ok" ? "status" : "alert"}
        >
          {notice.message}
        </p>
      )}
      <section class="card card-wide">
        <dl class="facts">
          <dt>Ref</dt>
          <dd>
            <code>{project.ref}</code>
          </dd>
          <dt>Box</dt>
          <dd>
            {box.name}
            {box.devOnly && <span class="badge">development only</span>}
          </dd>
          <dt>Database</dt>
          <dd>
            <code>{project.dbName}</code>
          </dd>
          <dt>Owner role</dt>
          <dd>
            <code>{project.ownerRole}</code>
          </dd>
        </dl>
      </section>
      <section class="card card-wide">
        <h2>Connection strings</h2>
        {strings ? (
          <ConnectionStrings strings={strings} />
        ) : (
          <p class="alert alert-error" role="alert">
            The stored owner password cannot be decrypted, so the connection strings cannot be
            shown. If the stored secret is corrupt, rotating the password sets a new one.
          </p>
        )}
        <form method="post" action={`${base}/rotate`} class="form-inline">
          <button type="submit" class="button-quiet button-danger">
            Rotate password
          </button>
          <small class="hint">Apps using the current password lose access.</small>
        </form>
      </section>
      <Backups
        base={base}
        backups={backups}
        schedule={schedule}
        backupHourUtc={backupHourUtc}
        s3Configured={s3Configured}
      />
      <section class="card card-wide">
        <h2>Display name</h2>
        <form method="post" action={`${base}/name`} class="form-inline">
          <input name="name" required maxlength={100} value={project.name} aria-label="Name" />
          <button type="submit" class="button">
            Save
          </button>
        </form>
      </section>
      <section class="card card-wide" id="delete">
        <h2>Delete project</h2>
        <p class="hint">
          Moves the project to Trash: the owner can no longer connect and Studio stops showing it.
          It can be restored until it is purged. Type <code>{project.ref}</code> to confirm.
        </p>
        <form method="post" action={`${base}/delete`} class="form-inline">
          <ConfirmRefInput ref={project.ref} />
          <button type="submit" class="button-quiet button-danger">
            Delete project
          </button>
        </form>
      </section>
      <script dangerouslySetInnerHTML={{ __html: CREDENTIALS_SCRIPT }} />
    </Layout>
  );
}
