import { SSL_MODES } from "../../boxes/admin-client.js";
import type { BoxFormValues } from "../../boxes/service.js";
import type { Box } from "../../registry/boxes.js";
import { Layout } from "../layout.js";

export interface BoxRow {
  box: Box;
  projectCount: number;
}

function RemoveButton({ box }: { box: Box }) {
  return (
    <form method="post" action={`/_hs/boxes/${box.id}/remove`}>
      <button type="submit" class="button-quiet button-danger">
        Remove
      </button>
    </form>
  );
}

function BoxActions({ box, managedEnabled }: { box: Box; managedEnabled: boolean }) {
  if (box.kind === "registered") {
    return (
      <>
        <a class="button-quiet" href={`/_hs/boxes/${box.id}/edit`}>
          Edit
        </a>
        <RemoveButton box={box} />
      </>
    );
  }
  if (box.kind === "managed" && managedEnabled) return <RemoveButton box={box} />;
  return (
    <span class="hint">
      {box.kind === "shared" ? "Managed by environment" : "Managed by hattisar"}
    </span>
  );
}

export function BoxesPage({
  rows,
  managedEnabled = false,
  error,
}: {
  rows: BoxRow[];
  managedEnabled?: boolean;
  error?: string;
}) {
  return (
    <Layout title="Boxes" section="boxes">
      <div class="page-head">
        <h1>Boxes</h1>
        <div class="row-actions">
          {managedEnabled && (
            <a class="button-quiet" href="/_hs/managed-boxes/new">
              New managed box
            </a>
          )}
          <a class="button" href="/_hs/boxes/new">
            Register box
          </a>
        </div>
      </div>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <div class="empty">
          <p>No boxes registered.</p>
        </div>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Host</th>
              <th>Projects</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ box, projectCount }) => (
              <tr data-box={box.name}>
                <td>
                  {box.name}
                  {box.devOnly && <span class="badge">dev only</span>}
                </td>
                <td>{box.kind}</td>
                <td>
                  <code>{`${box.host}:${box.port}`}</code>
                </td>
                <td>{projectCount}</td>
                <td class="row-actions">
                  <BoxActions box={box} managedEnabled={managedEnabled} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
}

const EMPTY_VALUES: BoxFormValues = {
  name: "",
  host: "",
  port: "5432",
  adminUser: "",
  sslmode: "require",
  publicHost: "",
  publicPort: "5432",
  devOnly: false,
};

export function BoxFormPage({
  boxId,
  values = EMPTY_VALUES,
  problems = [],
}: {
  boxId?: number;
  values?: BoxFormValues;
  problems?: string[];
}) {
  const editing = boxId !== undefined;
  const title = editing ? `Edit box ${values.name}` : "Register box";
  return (
    <Layout title={title} section="boxes">
      <h1>{title}</h1>
      <section class="card">
        <form method="post" action={editing ? `/_hs/boxes/${boxId}` : "/_hs/boxes"} class="form">
          {problems.length > 0 && (
            <div class="alert alert-error" role="alert">
              <p>This box can't be used yet:</p>
              <ul class="problems">
                {problems.map((problem) => (
                  <li>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          <label class="field">
            <span>Name</span>
            <input name="name" required pattern="[a-z][a-z0-9\-]{2,39}" value={values.name} />
            <small class="hint">Lowercase letters, digits and hyphens; 3–40 characters.</small>
          </label>
          <label class="field">
            <span>Host</span>
            <input name="host" required value={values.host} />
          </label>
          <label class="field">
            <span>Port</span>
            <input name="port" type="number" min={1} max={65535} required value={values.port} />
          </label>
          <label class="field">
            <span>Admin user</span>
            <input name="adminUser" required autocomplete="off" value={values.adminUser} />
          </label>
          <label class="field">
            <span>Admin password</span>
            <input
              name="adminPassword"
              type="password"
              autocomplete="new-password"
              required={!editing}
            />
            {editing && <small class="hint">Leave blank to keep the current password.</small>}
          </label>
          <label class="field">
            <span>SSL mode</span>
            <select name="sslmode">
              {SSL_MODES.map((mode) => (
                <option value={mode} selected={mode === values.sslmode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>Public host</span>
            <input name="publicHost" required value={values.publicHost} />
            <small class="hint">Host clients use in connection strings.</small>
          </label>
          <label class="field">
            <span>Public port</span>
            <input
              name="publicPort"
              type="number"
              min={1}
              max={65535}
              required
              value={values.publicPort}
            />
          </label>
          <label class="checkbox">
            <input name="devOnly" type="checkbox" checked={values.devOnly} />
            <span>Development only</span>
          </label>
          <div class="form-actions">
            <button type="submit" class="button">
              {editing ? "Save" : "Register"}
            </button>
            <a class="button-quiet" href="/_hs/boxes">
              Cancel
            </a>
          </div>
        </form>
      </section>
    </Layout>
  );
}

export function ManagedBoxFormPage({
  name = "",
  problems = [],
}: {
  name?: string;
  problems?: string[];
}) {
  return (
    <Layout title="New managed box" section="boxes">
      <h1>New managed box</h1>
      <section class="card">
        <form method="post" action="/_hs/managed-boxes" class="form">
          {problems.length > 0 && (
            <div class="alert alert-error" role="alert">
              <p>The box could not be started:</p>
              <ul class="problems">
                {problems.map((problem) => (
                  <li>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          <label class="field">
            <span>Name</span>
            <input name="name" required pattern="[a-z][a-z0-9\-]{2,39}" value={name} />
            <small class="hint">
              Lowercase letters, digits and hyphens; 3–40 characters. hattisar starts a dedicated
              Postgres container for it, which can take a minute or two.
            </small>
          </label>
          <div class="form-actions">
            <button type="submit" class="button">
              Start box
            </button>
            <a class="button-quiet" href="/_hs/boxes">
              Cancel
            </a>
          </div>
        </form>
      </section>
    </Layout>
  );
}
