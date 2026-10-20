import { Layout } from "../layout.js";

export interface PasswordFormResult {
  error?: string;
  saved?: boolean;
}

export function SettingsPage({ password = {} }: { password?: PasswordFormResult }) {
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
    </Layout>
  );
}
