import { Document } from "../layout.js";

export function LoginPage({ error, username = "" }: { error?: string; username?: string }) {
  return (
    <Document title="Log in">
      <body class="centered">
        <main class="card login">
          <h1 class="brand-title">hattisar</h1>
          <form method="post" action="/_hs/login" class="form">
            {error && (
              <p class="alert alert-error" role="alert">
                {error}
              </p>
            )}
            <label class="field">
              <span>Username</span>
              <input name="username" autocomplete="username" required value={username} />
            </label>
            <label class="field">
              <span>Password</span>
              <input name="password" type="password" autocomplete="current-password" required />
            </label>
            <button type="submit" class="button">
              Log in
            </button>
          </form>
        </main>
      </body>
    </Document>
  );
}
