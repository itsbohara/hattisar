import type { ConnectionString } from "../../projects/connection-strings.js";
import { slugify } from "../../projects/naming.js";
import type { Box } from "../../registry/boxes.js";
import type { Project } from "../../registry/projects.js";
import { Layout } from "../layout.js";
import { ConfirmRefInput } from "./trash.js";

export const DEV_ONLY_WARNING =
  "Best for development only — shares one Postgres with other projects";

export interface ProjectRow {
  project: Project;
  box: Box;
}

function studioHref(ref: string): string {
  return `/project/${ref}/editor`;
}

function Problems({ problems }: { problems: string[] }) {
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
}

// The ref follows the name until the user types into it.
const SLUG_SCRIPT = `(() => {
  const slugify = ${slugify.toString()};
  const form = document.getElementById("new-project");
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

export function NewProjectPage({
  boxes,
  values,
  problems = [],
}: {
  boxes: Box[];
  values: NewProjectValues;
  problems?: string[];
}) {
  return (
    <Layout title="New project" section="projects">
      <h1>New project</h1>
      <section class="card card-roomy">
        <form method="post" action="/_hs/projects" class="form" id="new-project">
          <Problems problems={problems} />
          <label class="field">
            <span>Name</span>
            <input name="name" required maxlength={100} value={values.name} />
          </label>
          <label class="field">
            <span>Ref</span>
            <input name="ref" required pattern="[a-z][a-z0-9\-]{2,39}" value={values.ref} />
            <small class="hint">
              Lowercase letters, digits and hyphens; 3–40 characters. Names the database and can't
              be changed later.
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
            </select>
          </label>
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
      <script dangerouslySetInnerHTML={{ __html: SLUG_SCRIPT }} />
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

export interface ProjectPageNotice {
  kind: "ok" | "error";
  message: string;
}

export function ProjectPage({
  project,
  box,
  strings,
  notice,
}: {
  project: Project;
  box: Box;
  strings: ConnectionString[];
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
