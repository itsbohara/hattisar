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
}

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

export function ProjectsPage({ rows }: { rows: ProjectRow[] }) {
  return (
    <Layout title="Projects" section="projects">
      <div class="page-head">
        <h1>Projects</h1>
        <a class="button" href="/_hs/projects/new">
          New project
        </a>
      </div>
      {rows.length === 0 ? (
        <div class="empty">
          <p>No projects yet.</p>
        </div>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Ref</th>
              <th>Box</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ project, box }) => (
              <tr data-project={project.ref}>
                <td>
                  <a href={`/_hs/projects/${project.ref}`}>{project.name}</a>
                </td>
                <td>
                  <code>{project.ref}</code>
                </td>
                <td>
                  {box.name}
                  {box.devOnly && <span class="badge">development only</span>}
                </td>
                <td class="row-actions">
                  <a class="button-quiet" href={studioHref(project.ref)}>
                    Open in Studio
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
              <th>Kind</th>
              <th>Size</th>
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
  strings: ConnectionString[];
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
        <ConnectionStrings strings={strings} />
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
      <section class="card card-wide">
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
