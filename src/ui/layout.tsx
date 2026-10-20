import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const APP_CSS_PATH = "/_hs/static/app.css";

export async function renderPage(
  c: Context,
  page: HtmlEscapedString | Promise<HtmlEscapedString>,
  status: ContentfulStatusCode = 200,
): Promise<Response> {
  // Back after logout must not show an authenticated page from the browser cache.
  return c.html(`<!doctype html>${await page}`, status, { "cache-control": "no-store" });
}

export type Section = "projects" | "trash" | "boxes" | "settings";

const NAV: { section: Section; label: string; href: string }[] = [
  { section: "projects", label: "Projects", href: "/_hs/projects" },
  { section: "trash", label: "Trash", href: "/_hs/trash" },
  { section: "boxes", label: "Boxes", href: "/_hs/boxes" },
  { section: "settings", label: "Settings", href: "/_hs/settings" },
];

export function Document({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        <title>{`${title} · hattisar`}</title>
        <link rel="stylesheet" href={APP_CSS_PATH} />
      </head>
      {children}
    </html>
  );
}

export function Layout({
  title,
  section,
  children,
}: {
  title: string;
  section: Section;
  children: Child;
}) {
  return (
    <Document title={title}>
      <body>
        <header class="topbar">
          <a class="brand" href="/_hs/projects">
            hattisar
          </a>
          <nav class="nav">
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
          <form method="post" action="/_hs/logout" class="logout">
            <button type="submit" class="button-quiet">
              Log out
            </button>
          </form>
        </header>
        <main class="main">{children}</main>
      </body>
    </Document>
  );
}
