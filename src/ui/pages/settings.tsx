import type { Child } from "hono/jsx";
import type { S3FormValues } from "../../backups/s3-settings.js";
import { Layout } from "../layout.js";

export const ACCOUNT_SETTINGS = "/_hs/settings/account";
export const STORAGE_SETTINGS = "/_hs/settings/storage";

type SettingsSection = "account" | "storage";

const SECTIONS: { section: SettingsSection; label: string; href: string }[] = [
  { section: "account", label: "Account", href: ACCOUNT_SETTINGS },
  { section: "storage", label: "Backup storage", href: STORAGE_SETTINGS },
];

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

function SettingsLayout({ current, children }: { current: SettingsSection; children: Child }) {
  return (
    <Layout title="Settings" section="settings">
      <h1>Settings</h1>
      <div class="settings">
        <nav class="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <a
              href={item.href}
              class="settings-nav-link"
              aria-current={item.section === current ? "page" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div class="settings-content">{children}</div>
      </div>
    </Layout>
  );
}

export function AccountSettingsPage({
  username,
  password = {},
}: {
  username: string;
  password?: PasswordFormResult;
}) {
  return (
    <SettingsLayout current="account">
      <div class="settings-head">
        <h2>Account</h2>
        <p class="hint">
          Signed in as <strong class="settings-username">{username}</strong>
        </p>
      </div>
      <section class="card" aria-labelledby="change-password">
        <h3 id="change-password">Change password</h3>
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
    </SettingsLayout>
  );
}

function endpointHost(endpoint: string): string {
  return URL.canParse(endpoint) ? new URL(endpoint).host : endpoint;
}

function StorageStatus({ stored }: { stored: S3FormValues | undefined }) {
  if (!stored) {
    return <p class="settings-status">Not configured — backups and restores need this.</p>;
  }
  return (
    <p class="settings-status settings-status-ok">
      Configured · bucket <code>{stored.bucket}</code>
      {stored.endpoint && <> on {endpointHost(stored.endpoint)}</>}
    </p>
  );
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

export function StorageSettingsPage({
  s3,
  stored,
}: {
  s3: S3FormState;
  stored: S3FormValues | undefined;
}) {
  const { values, secretSet } = s3;
  return (
    <SettingsLayout current="storage">
      <div class="settings-head">
        <h2>Backup storage</h2>
        <StorageStatus stored={stored} />
      </div>
      <section class="card" aria-label="S3 connection">
        <form method="post" action="/_hs/settings/s3" class="form">
          <S3Notices {...s3} />
          <div class="form-grid">
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
              <span>Key prefix</span>
              <input name="prefix" value={values.prefix} placeholder="hattisar" />
              <small class="hint">Backups are stored under prefix/ref/.</small>
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
            <label class="checkbox form-grid-full">
              <input name="forcePathStyle" type="checkbox" checked={values.forcePathStyle} />
              <span>Force path-style URLs</span>
            </label>
          </div>
          {/* Save stays first in source so Enter in a field saves; CSS shows it on the right. */}
          <div class="form-actions form-actions-split">
            <button type="submit" class="button">
              Save
            </button>
            <button type="submit" class="button-quiet" formaction="/_hs/settings/s3/test">
              Test connection
            </button>
          </div>
        </form>
      </section>
    </SettingsLayout>
  );
}
