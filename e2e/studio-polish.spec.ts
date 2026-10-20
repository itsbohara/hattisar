import { expect, type Page, test } from "@playwright/test";

const REF = "spike-b";
const HIDDEN_SECTIONS = ["auth/users", "storage/files", "functions", "realtime/inspector"];

function sidebarLink(page: Page, section: string) {
  return page.locator(`nav a[href="/project/${REF}/${section}"]`);
}

async function expectHattisarChrome(page: Page): Promise<void> {
  await expect(sidebarLink(page, "editor")).toBeVisible();
  for (const section of HIDDEN_SECTIONS) {
    await expect(sidebarLink(page, section), section).toBeAttached();
    await expect(sidebarLink(page, section), section).toBeHidden();
  }
  await expect(page.getByRole("link", { name: "← hattisar" })).toBeVisible();
}

test("Studio hides the sections hattisar does not serve and links back", async ({ page }) => {
  await page.goto(`/project/${REF}/editor`);
  await expectHattisarChrome(page);

  await sidebarLink(page, "sql").click();
  await expect(page).toHaveURL(new RegExp(`/project/${REF}/sql/`));
  await expectHattisarChrome(page);

  await page.getByRole("link", { name: "← hattisar" }).click();
  await expect(page).toHaveURL("/_hs/projects");
});

test("the projects page opens a project in Studio's table editor", async ({ page }) => {
  await page.goto("/_hs/projects");
  const open = page.locator(`a[href="/project/${REF}/editor"]`, { hasText: "Open in Studio" });
  await open.click();
  await expect(page).toHaveURL(`/project/${REF}/editor`);
  await expectHattisarChrome(page);
});

for (const [path, target] of [
  ["/org/x", "/_hs/projects"],
  ["/org/x/general", "/_hs/projects"],
  ["/organizations", "/_hs/projects"],
  ["/projects", "/_hs/projects"],
  ["/project/default", "/_hs/projects"],
  ["/new/x", "/_hs/projects/new"],
] as const) {
  test(`Studio's ${path} lands on hattisar's ${target}`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(target);
  });
}

test("Studio saves a SQL snippet", async ({ page }) => {
  await page.goto(`/project/${REF}/sql/new`);
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" && r.url().endsWith(`/api/platform/projects/${REF}/content`),
  );
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.type("select 1;");
  const response = await saved;
  expect(response.status()).toBe(200);

  await expect(page).toHaveURL(new RegExp(`/project/${REF}/sql/[0-9a-f-]{36}$`));
  const id = new URL(page.url()).pathname.split("/").pop();
  const deleted = await page.request.delete(`/api/platform/projects/${REF}/content?ids=${id}`, {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(deleted.ok()).toBe(true);
});
