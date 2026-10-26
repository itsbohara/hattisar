import { isAttached } from "../../projects/attach.js";
import type { Backup } from "../../registry/backups.js";
import type { Box } from "../../registry/boxes.js";
import type { Project } from "../../registry/projects.js";
import { Layout } from "../layout.js";
import {
  formatBytes,
  type NewProjectValues,
  Problems,
  ProjectFields,
  projectTabHref,
  slugScript,
} from "./projects.js";
import { ConfirmRefInput, utc } from "./trash.js";

export function RestorePage({
  project,
  backup,
  boxes,
  values,
  sameProblem,
  newProblems = [],
}: {
  project: Project;
  backup: Backup;
  boxes: Box[];
  values: NewProjectValues;
  sameProblem?: string;
  newProblems?: string[];
}) {
  const base = `/_hs/projects/${project.ref}/backups/${backup.id}`;
  return (
    <Layout title="Restore backup" section="projects">
      <div class="page-head">
        <h1>Restore backup</h1>
        <a class="button-quiet" href={projectTabHref(project.ref, "backups")}>
          Back to {project.name}
        </a>
      </div>
      <section class="card card-wide">
        <dl class="facts">
          <dt>Project</dt>
          <dd>
            <code>{project.ref}</code>
          </dd>
          <dt>Taken</dt>
          <dd>{utc(new Date(backup.createdAt))}</dd>
          <dt>Kind</dt>
          <dd>{backup.kind}</dd>
          <dt>Size</dt>
          <dd>{backup.sizeBytes === null ? "" : formatBytes(backup.sizeBytes)}</dd>
        </dl>
        <p class="hint">
          A backup returns the database to when it was taken, not to any point in time.
        </p>
      </section>
      {!isAttached(project) && (
        <section class="card card-wide" id="restore-same">
          <h2>Into this project</h2>
          <p class="hint">
            Drops database <code>{project.dbName}</code> and recreates it from the backup.
            Everything written since the backup is lost and open connections are cut. The owner role
            and its password stay the same. Type <code>{project.ref}</code> to confirm.
          </p>
          {sameProblem && <Problems problems={[sameProblem]} />}
          <form method="post" action={`${base}/restore`} class="form-inline">
            <ConfirmRefInput ref={project.ref} />
            <button type="submit" class="button-quiet button-danger">
              Restore into {project.ref}
            </button>
          </form>
        </section>
      )}
      <section class="card card-roomy" id="restore-new">
        <h2>Into a new project</h2>
        <p class="hint">
          Creates a project the way New project does, then restores the backup into it. If the
          restore fails, the new project is kept with whatever was restored.
        </p>
        <form method="post" action={`${base}/restore-new`} class="form" id="restore-new-project">
          <Problems problems={newProblems} />
          <ProjectFields boxes={boxes} values={values} />
          <div class="form-actions">
            <button type="submit" class="button">
              Create and restore
            </button>
          </div>
        </form>
      </section>
      <script dangerouslySetInnerHTML={{ __html: slugScript("restore-new-project") }} />
    </Layout>
  );
}
