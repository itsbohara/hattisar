import type { Box } from "../../registry/boxes.js";
import { Layout } from "../layout.js";
import { Problems, slugScript } from "./projects.js";

export interface AttachValues {
  name: string;
  ref: string;
  database: string;
  login: string;
}

const FORM_ID = "attach-project";

function BoxPicker({ boxes }: { boxes: Box[] }) {
  if (boxes.length === 0) {
    return (
      <div class="empty">
        <p>Only registered boxes can attach databases, and none is registered.</p>
        <a class="button" href="/_hs/boxes/new">
          Register box
        </a>
      </div>
    );
  }
  return (
    <form method="get" action="/_hs/projects/attach" class="form">
      <label class="field">
        <span>Box</span>
        <select name="box">
          {boxes.map((box) => (
            <option value={String(box.id)}>{box.name}</option>
          ))}
        </select>
      </label>
      <div class="form-actions">
        <button type="submit" class="button">
          Continue
        </button>
        <a class="button-quiet" href="/_hs/projects/new">
          Cancel
        </a>
      </div>
    </form>
  );
}

function AttachForm({
  box,
  databases,
  values,
}: {
  box: Box;
  databases: string[];
  values: AttachValues;
}) {
  return (
    <form method="post" action="/_hs/projects/attach" class="form" id={FORM_ID}>
      <input type="hidden" name="boxId" value={String(box.id)} />
      <p class="hint">
        Box <strong>{box.name}</strong>. hattisar never changes the database or its login.
      </p>
      <label class="field">
        <span>Database</span>
        <select name="database" required>
          {databases.map((database) => (
            <option value={database} selected={database === values.database}>
              {database}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span>Name</span>
        <input name="name" required maxlength={100} value={values.name} />
      </label>
      <label class="field">
        <span>Ref</span>
        <input name="ref" required pattern="[a-z][a-z0-9\-]{2,39}" value={values.ref} />
        <small class="hint">
          Lowercase letters, digits and hyphens; 3–40 characters. Need not match the database name.
        </small>
      </label>
      <label class="field">
        <span>Login</span>
        <input name="login" required autocomplete="off" value={values.login} />
      </label>
      <label class="field">
        <span>Password</span>
        <input name="password" type="password" autocomplete="new-password" required />
        <small class="hint">Studio signs in with this login and password.</small>
      </label>
      <div class="form-actions">
        <button type="submit" class="button">
          Attach database
        </button>
        <a class="button-quiet" href="/_hs/projects">
          Cancel
        </a>
      </div>
    </form>
  );
}

export function AttachPage({
  boxes,
  box,
  databases,
  values,
  problems = [],
}: {
  boxes: Box[];
  box: Box | undefined;
  databases: string[];
  values: AttachValues;
  problems?: string[];
}) {
  return (
    <Layout title="Attach existing database" section="projects">
      <h1>Attach existing database</h1>
      <section class="card card-roomy">
        <Problems problems={problems} />
        {box ? (
          <AttachForm box={box} databases={databases} values={values} />
        ) : (
          <BoxPicker boxes={boxes} />
        )}
      </section>
      {box && <script dangerouslySetInnerHTML={{ __html: slugScript(FORM_ID) }} />}
    </Layout>
  );
}
