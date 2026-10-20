import type { Box } from "../../registry/boxes.js";
import type { Project } from "../../registry/projects.js";
import { Layout } from "../layout.js";

export interface TrashRow {
  project: Project;
  box: Box;
  purgeAt: Date;
}

export function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function ConfirmRefInput({ ref }: { ref: string }) {
  return (
    <input
      name="confirm"
      required
      autocomplete="off"
      class="confirm-input"
      placeholder={ref}
      aria-label={`Type ${ref} to confirm`}
    />
  );
}

export function TrashPage({
  rows,
  purgeAfterDays,
  problem,
}: {
  rows: TrashRow[];
  purgeAfterDays: number;
  problem?: string;
}) {
  return (
    <Layout title="Trash" section="trash">
      <div class="page-head">
        <h1>Trash</h1>
      </div>
      {problem && (
        <p class="alert alert-error" role="alert">
          {problem}
        </p>
      )}
      {rows.length === 0 ? (
        <div class="empty">
          <p>Trash is empty.</p>
        </div>
      ) : (
        <>
          <p class="hint">
            Deleted projects are purged for good {purgeAfterDays} days after deletion. Purging drops
            the database and owner role; backups in S3 are kept.
          </p>
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Ref</th>
                <th>Box</th>
                <th>Deleted</th>
                <th>Purged after</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ project, box, purgeAt }) => (
                <tr data-project={project.ref}>
                  <td>{project.name}</td>
                  <td>
                    <code>{project.ref}</code>
                  </td>
                  <td>{box.name}</td>
                  <td>{project.deletedAt && utc(new Date(project.deletedAt))}</td>
                  <td>{utc(purgeAt)}</td>
                  <td class="row-actions">
                    <form method="post" action={`/_hs/trash/${project.ref}/restore`}>
                      <button type="submit" class="button-quiet">
                        Restore
                      </button>
                    </form>
                    <form
                      method="post"
                      action={`/_hs/trash/${project.ref}/purge`}
                      class="form-inline"
                    >
                      <ConfirmRefInput ref={project.ref} />
                      <button type="submit" class="button-quiet button-danger">
                        Purge now
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Layout>
  );
}
