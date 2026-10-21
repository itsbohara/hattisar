import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { listApiTokens } from "../registry/api-tokens.js";
import type { Registry } from "../registry/db.js";
import { deleteOtherSessions } from "../registry/sessions.js";
import { getUserByUsername, updateUserPasswordHash } from "../registry/users.js";
import { renderPage } from "../ui/layout.js";
import { LoginPage } from "../ui/pages/login.js";
import {
  ACCOUNT_SETTINGS,
  AccountSettingsPage,
  API_TOKENS_SETTINGS,
  ApiTokensSettingsPage,
  STORAGE_SETTINGS,
  type TokenFormState,
} from "../ui/pages/settings.js";
import { createApiToken, revokeApiToken, type TokenExpiryDays } from "./api-tokens.js";
import { type AuthEnv, LOGIN_PAGE } from "./middleware.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { LoginRateLimiter } from "./rate-limit.js";
import { clearSessionCookie, readSessionCookie, writeSessionCookie } from "./session-cookie.js";
import { createSession, endSession, resolveSession } from "./sessions.js";

export const HOME_PAGE = "/_hs/projects";
const MIN_PASSWORD_LENGTH = 12;

export interface AuthRoutesDeps {
  db: Registry;
  limiter: LoginRateLimiter;
  cookieSecure: boolean;
}

function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value : "";
}

// "never" means no expiry; anything else goes through as a number for createApiToken to reject.
function expiryDays(value: string): TokenExpiryDays | null {
  return value === "never" ? null : (Number(value) as TokenExpiryDays);
}

export function authRoutes({ db, limiter, cookieSecure }: AuthRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Unknown usernames are checked against this too, so response time does not reveal which exist.
  const unknownUserHash = hashPassword("hattisar-unknown-user");

  app.get(LOGIN_PAGE, async (c) => {
    const token = readSessionCookie(c);
    if (token !== undefined && resolveSession(db, token)) return c.redirect(HOME_PAGE, 302);
    return renderPage(c, <LoginPage />);
  });

  app.post(LOGIN_PAGE, async (c) => {
    const form = await c.req.parseBody();
    const username = field(form, "username");
    const password = field(form, "password");

    if (limiter.isBlocked(username)) {
      const error = "Too many failed attempts. Try again in 15 minutes.";
      return renderPage(c, <LoginPage error={error} username={username} />, 429);
    }

    const user = getUserByUsername(db, username);
    const valid = await verifyPassword(password, user?.passwordHash ?? (await unknownUserHash));
    if (!user || !valid) {
      limiter.recordFailure(username);
      const error = "Wrong username or password.";
      return renderPage(c, <LoginPage error={error} username={username} />, 401);
    }

    limiter.recordSuccess(username);
    writeSessionCookie(c, createSession(db, user.id), cookieSecure);
    return c.redirect(HOME_PAGE, 302);
  });

  app.post("/_hs/logout", (c) => {
    endSession(db, c.var.session.tokenHash);
    clearSessionCookie(c, cookieSecure);
    return c.redirect(LOGIN_PAGE, 302);
  });

  app.get("/_hs/settings", (c) => c.redirect(STORAGE_SETTINGS, 302));

  app.get(ACCOUNT_SETTINGS, (c) =>
    renderPage(c, <AccountSettingsPage username={c.var.session.user.username} />),
  );

  app.post("/_hs/settings/password", async (c) => {
    const { user, tokenHash } = c.var.session;
    const form = await c.req.parseBody();
    const password = field(form, "password");

    let error: string | undefined;
    if (!(await verifyPassword(field(form, "current"), user.passwordHash))) {
      error = "Current password is wrong.";
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      error = `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (password !== field(form, "confirm")) {
      error = "New password and confirmation do not match.";
    }
    if (error) {
      return renderPage(
        c,
        <AccountSettingsPage username={user.username} password={{ error }} />,
        400,
      );
    }

    updateUserPasswordHash(db, user.id, await hashPassword(password));
    deleteOtherSessions(db, user.id, tokenHash);
    return renderPage(
      c,
      <AccountSettingsPage username={user.username} password={{ saved: true }} />,
    );
  });

  function renderTokens(
    c: Context<AuthEnv>,
    form: TokenFormState = {},
    status: ContentfulStatusCode = 200,
  ) {
    const tokens = listApiTokens(db, c.var.session.user.id);
    return renderPage(c, <ApiTokensSettingsPage tokens={tokens} form={form} />, status);
  }

  app.get(API_TOKENS_SETTINGS, (c) => renderTokens(c));

  app.post(API_TOKENS_SETTINGS, async (c) => {
    const form = await c.req.parseBody();
    const name = field(form, "name");
    const expiry = field(form, "expiry");
    const result = createApiToken(db, c.var.session.user.id, name, expiryDays(expiry));
    if (!result.ok) return renderTokens(c, { name, expiry, problem: result.problem }, 400);
    // Rendered, not redirected: the token must never travel in a URL.
    const created = { token: result.token, origin: new URL(c.req.url).origin };
    return renderTokens(c, { created }, 201);
  });

  app.post(`${API_TOKENS_SETTINGS}/:id/revoke`, (c) => {
    const id = c.req.param("id");
    if (!/^\d+$/.test(id) || !revokeApiToken(db, c.var.session.user.id, Number(id))) {
      return c.notFound();
    }
    return c.redirect(API_TOKENS_SETTINGS, 302);
  });

  return app;
}
