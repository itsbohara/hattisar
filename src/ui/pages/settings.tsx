import type { S3FormValues } from "../../backups/s3-settings.js";
import { Layout } from "../layout.js";

export interface PasswordFormResult {
  error?: string;
  saved?: boolean;
}

export interface S3FormState {
  values: S3FormValues;
  secretSet: boolean;
  problems?: string[];
  saved?: boolean;
  test?: ({ ok: true } | { ok: false; problem: string }) & { secretTyped: boolean };
}

function S3Notices({ problems = [], saved, test }: S3FormState) {
  return (
    <>
      {problems.length > 0 && (
        <div class="alert alert-error" role="alert">
          <ul class="problems">
            {problems.map((problem) => (
              <li>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {saved && (
        <p class="alert alert-ok" role="status">
          S3 settings saved.
        </p>
      )}
      {test?.ok && (
        <p class="alert alert-ok" role="status">
          Connection works: hattisar wrote and deleted a test object.
        </p>
      )}
      {test && !test.ok && (
        <p class="alert alert-error" role="alert">
          Connection failed: {test.problem}
        </p>
      )}
      {test?.secretTyped && (
        <p class="hint">Nothing was saved. Enter the secret access key again to save it.</p>
      )}
    </>
  );
}

function S3Section({ s3 }: { s3: S3FormState }) {
  const { values, secretSet } = s3;
  return (
    <section class="card">
      <h2>Backup storage (S3)</h2>
      <form method="post" action="/_hs/settings/s3" class="form">
        <S3Notices {...s3} />
        <label class="field">
          <span>Endpoint</span>
          <input name="endpoint" type="url" value={values.endpoint} placeholder="https://" />
          <small class="hint">Leave blank for AWS S3; set it for S3-compatible storage.</small>
        </label>
        <label class="field">
          <span>Region</span>
          <input name="region" required value={values.region} placeholder="us-east-1" />
        </label>
        <label class="field">
          <span>Bucket</span>
          <input name="bucket" required value={values.bucket} />
        </label>
        <label class="field">
          <span>Access key ID</span>
          <input name="accessKeyId" required autocomplete="off" value={values.accessKeyId} />
        </label>
        <label class="field">
          <span>Secret access key</span>
          <input
            name="secretAccessKey"
            type="password"
            autocomplete="new-password"
            required={!secretSet}
          />
          {secretSet && <small class="hint">Leave blank to keep the saved key.</small>}
        </label>
        <label class="checkbox">
          <input name="forcePathStyle" type="checkbox" checked={values.forcePathStyle} />
          <span>Force path-style URLs</span>
        </label>
        <label class="field">
          <span>Key prefix</span>
          <input name="prefix" value={values.prefix} placeholder="hattisar" />
          <small class="hint">Backups are stored under prefix/ref/.</small>
        </label>
        <div class="form-actions">
          <button type="submit" class="button">
            Save
          </button>
          <button type="submit" class="button-quiet" formaction="/_hs/settings/s3/test">
            Test connection
          </button>
        </div>
      </form>
    </section>
  );
}

export function SettingsPage({
  password = {},
  s3,
}: {
  password?: PasswordFormResult;
  s3: S3FormState;
}) {
  return (
    <Layout title="Settings" section="settings">
      <h1>Settings</h1>
      <section class="card">
        <h2>Change password</h2>
        <form method="post" action="/_hs/settings/password" class="form">
          {password.error && (
            <p class="alert alert-error" role="alert">
              {password.error}
            </p>
          )}
          {password.saved && (
            <p class="alert alert-ok" role="status">
              Password changed. Other sessions were logged out.
            </p>
          )}
          <label class="field">
            <span>Current password</span>
            <input name="current" type="password" autocomplete="current-password" required />
          </label>
          <label class="field">
            <span>New password</span>
            <input
              name="password"
              type="password"
              autocomplete="new-password"
              minlength={12}
              required
            />
            <small class="hint">At least 12 characters.</small>
          </label>
          <label class="field">
            <span>Confirm new password</span>
            <input
              name="confirm"
              type="password"
              autocomplete="new-password"
              minlength={12}
              required
            />
          </label>
          <button type="submit" class="button">
            Change password
          </button>
        </form>
      </section>
      <S3Section s3={s3} />
    </Layout>
  );
}
