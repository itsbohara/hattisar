import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { type Child, createContext, useContext } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ActiveSession } from "../auth/sessions.js";

export const APP_CSS_PATH = "/_hs/static/app.css";
export const APP_JS_PATH = "/_hs/static/app.js";
export const THEME_PATH = "/_hs/theme";
export const THEME_COOKIE = "hs_theme";

export type Theme = "light" | "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

interface PageContextValue {
  theme?: Theme;
  username?: string;
  path: string;
}

const PageContext = createContext<PageContextValue>({ path: "/_hs/projects" });

export async function renderPage(
  c: Context,
  page: HtmlEscapedString | Promise<HtmlEscapedString>,
  status: ContentfulStatusCode = 200,
): Promise<Response> {
  const theme = getCookie(c, THEME_COOKIE);
  const session: ActiveSession | undefined = c.get("session");
  const url = new URL(c.req.url);
  const context: PageContextValue = {
    theme: isTheme(theme) ? theme : undefined,
    username: session?.user.username,
    path: `${url.pathname}${url.search}`,
  };
  const html = await (<PageContext.Provider value={context}>{page}</PageContext.Provider>);
  // Back after logout must not show an authenticated page from the browser cache.
  return c.html(`<!doctype html>${html}`, status, { "cache-control": "no-store" });
}

export type Section = "projects" | "trash" | "boxes" | "settings";

const NAV: { section: Section; label: string; href: string }[] = [
  { section: "projects", label: "Projects", href: "/_hs/projects" },
  { section: "trash", label: "Trash", href: "/_hs/trash" },
  { section: "boxes", label: "Boxes", href: "/_hs/boxes" },
  { section: "settings", label: "Settings", href: "/_hs/settings" },
];

const THEMES: { value: Theme | "system"; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export function Document({ title, children }: { title: string; children: Child }) {
  const { theme } = useContext(PageContext);
  return (
    <html lang="en" data-theme={theme}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        <title>{`${title} · hattisar`}</title>
        <link rel="stylesheet" href={APP_CSS_PATH} />
        <script src={APP_JS_PATH} defer />
      </head>
      {children}
    </html>
  );
}

function UserMenu() {
  const { theme, username, path } = useContext(PageContext);
  const current = theme ?? "system";
  return (
    <details class="menu user-menu" data-menu>
      <summary class="avatar" aria-label="Account menu" title={username}>
        {(username ?? "?").slice(0, 1).toUpperCase()}
      </summary>
      <div class="menu-panel menu-panel-right">
        <p class="menu-heading">{username}</p>
        <a class="menu-item" href="/_hs/settings/account">
          Account settings
        </a>
        <form method="post" action={THEME_PATH} class="menu-section">
          <input type="hidden" name="back" value={path} />
          <p class="menu-label">Theme</p>
          {THEMES.map(({ value, label }) => (
            <button
              type="submit"
              name="theme"
              value={value}
              class="menu-item menu-choice"
              aria-pressed={value === current ? "true" : "false"}
            >
              {label}
            </button>
          ))}
        </form>
        <form method="post" action="/_hs/logout" class="menu-section">
          <button type="submit" class="menu-item">
            Log out
          </button>
        </form>
      </div>
    </details>
  );
}

export function Layout({
  title,
  section,
  wide = false,
  children,
}: {
  title: string;
  section: Section;
  wide?: boolean;
  children: Child;
}) {
  return (
    <Document title={title}>
      <body>
        <header class="topbar">
          <a class="brand" href="/_hs/projects">
            hattisar
          </a>
          <nav class="nav" aria-label="Main">
            {NAV.map((item) => (
              <a
                href={item.href}
                aria-current={item.section === section ? "page" : undefined}
                class="nav-link"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <UserMenu />
        </header>
        <main class={wide ? "main main-wide" : "main"}>{children}</main>
      </body>
    </Document>
  );
}
