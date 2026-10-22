import { expect, type Page, test } from "@playwright/test";

const REF = "spike-b";
const OTHER_REF = "spike-a";
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
  await page.locator(`[data-project="${REF}"]`).click();
  await expect(page).toHaveURL(`/project/${REF}/editor`);
  await expectHattisarChrome(page);
});

test("Studio's Connect button opens hattisar's project page", async ({ page }) => {
  await page.goto(`/project/${REF}/editor`);
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await expect(page).toHaveURL(`/_hs/projects/${REF}`);
  await page.goBack();
  await expect(page).toHaveURL(`/project/${REF}/editor`);
  await expect(page.getByText("Connect to your project")).toBeHidden();
});

test("a Studio URL with showConnect opens hattisar's project page", async ({ page }) => {
  await page.goto(`/project/${REF}/editor?showConnect=true&connectTab=direct&method=session`);
  await expect(page).toHaveURL(`/_hs/projects/${REF}`);
});

test("Studio's logo lands on hattisar's projects page", async ({ page }) => {
  await page.goto(`/project/${REF}/editor`);
  await page.getByRole("link", { name: "Back to organization home" }).click();
  await expect(page).toHaveURL("/_hs/projects");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/project/${REF}/editor`));
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

async function listedSnippetIds(page: Page, ref: string): Promise<string[]> {
  const response = await page.request.get(
    `/api/platform/projects/${ref}/content?type=sql&limit=100`,
    {
      headers: { origin: new URL(page.url()).origin },
    },
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { data: { id: string }[] };
  return body.data.map((snippet) => snippet.id);
}

test("Studio saves a SQL snippet in its project only", async ({ page }) => {
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
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";

  await page.goto(`/project/${OTHER_REF}/sql/new`);
  await expect(page).toHaveURL(new RegExp(`/project/${OTHER_REF}/sql/`));
  expect(await listedSnippetIds(page, OTHER_REF)).not.toContain(id);

  await page.goto(`/project/${REF}/sql/${id}`);
  expect(await listedSnippetIds(page, REF)).toContain(id);

  const deleted = await page.request.delete(`/api/platform/projects/${REF}/content?ids=${id}`, {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(deleted.ok()).toBe(true);
  expect(await listedSnippetIds(page, REF)).not.toContain(id);
});
