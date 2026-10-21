import { expect, test } from "@playwright/test";

const card = (ref: string) => `[data-project="${ref}"]`;

test("search hides the projects that do not match, as you type", async ({ page }) => {
  await page.goto("/_hs/projects");
  const search = page.getByRole("searchbox", { name: "Search for a project" });

  await search.fill("spike-b");
  await expect(page.locator(card("spike-b"))).toBeVisible();
  await expect(page.locator(card("spike-a"))).toBeHidden();
  await expect(page).toHaveURL(/[?&]q=spike-b/);

  await search.fill("no-such-project");
  await expect(page.getByText("No projects match your search.")).toBeVisible();

  await search.fill("");
  await expect(page.locator(card("spike-a"))).toBeVisible();
});

test("the list view is remembered and its rows open Studio", async ({ page }) => {
  await page.goto("/_hs/projects");
  await page.getByRole("navigation", { name: "View" }).getByRole("link", { name: "List" }).click();
  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();

  await page.goto("/_hs/projects");
  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();

  await page.locator(card("spike-b")).getByRole("cell").nth(1).click();
  await expect(page).toHaveURL("/project/spike-b/editor");
});

test("a project's menu opens its hattisar page", async ({ page }) => {
  await page.goto("/_hs/projects");
  await page.getByLabel("Actions for Spike B").click();
  await page.getByRole("link", { name: "Project settings" }).click();
  await expect(page).toHaveURL("/_hs/projects/spike-b");
});

test("sizes load for each project and box", async ({ page }) => {
  await page.goto("/_hs/projects");
  await expect(page.locator('[data-size-of="spike-b"]')).toHaveText(/^\d+(\.\d)? (B|kB|MB|GB)$/);
  await expect(page.locator('.box-usage li[data-reachable="true"]').first()).toBeVisible();
});

test("the account menu switches the theme and System clears it", async ({ page }) => {
  await page.goto("/_hs/boxes");
  await page.getByLabel("Account menu").click();
  await page.getByRole("button", { name: "Light" }).click();
  await expect(page).toHaveURL("/_hs/boxes");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByLabel("Account menu").click();
  await page.getByRole("button", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});
