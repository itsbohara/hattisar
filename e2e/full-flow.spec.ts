import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { dropProject } from "../test/helpers/projects.js";
import { s3Fields, s3TestService } from "../test/helpers/s3.js";
import { adminCredentials } from "../test/helpers/session.js";
import { registrySql, stackEnv } from "../test/stack.js";

const REF = `e2e-flow-${randomUUID().slice(0, 8)}`;

test.use({ storageState: { cookies: [], origins: [] } });

test.afterAll(() => {
  dropProject(REF);
  registrySql("DELETE FROM settings WHERE key LIKE 's3.%'");
});

async function onPooler<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

test("a project's table survives being dropped by backing up to S3 and restoring", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { username, password } = adminCredentials();

  await page.goto("/_hs/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/_hs/projects");

  await page.goto("/_hs/settings/storage");
  for (const [name, value] of Object.entries(s3Fields(s3TestService(), { prefix: "e2e" }))) {
    if (name === "forcePathStyle") await page.locator(`input[name="${name}"]`).check();
    else await page.locator(`input[name="${name}"]`).fill(value);
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("S3 settings saved.")).toBeVisible();

  await page.goto("/_hs/projects/new");
  await page.locator('input[name="name"]').fill("E2E flow");
  await page.locator('input[name="ref"]').fill(REF);
  await expect(page.locator('select[name="boxId"] option:checked')).toHaveText(/^shared\b/);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(new RegExp(`/_hs/projects/${REF}`));

  const session = await page.locator("[data-url]").first().getAttribute("data-url");
  if (!session) throw new Error(`no connection string for ${REF}`);
  expect(new URL(session).port).toBe(stackEnv().POOLER_PORT_SESSION || "54322");
  await onPooler(session, (client) =>
    client.query(
      "create table public.notes (id int primary key, body text);" +
        "insert into public.notes values (1, 'kept by a backup')",
    ),
  );

  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page).toHaveURL(new RegExp(`/_hs/projects/${REF}\\?backed-up$`));
  await expect(page.getByText("Backup finished.")).toBeVisible();

  await onPooler(session, (client) => client.query("drop table public.notes"));

  await page.getByRole("link", { name: "Restore…" }).first().click();
  await page.locator("#restore-same").getByLabel(`Type ${REF} to confirm`).fill(REF);
  await page.getByRole("button", { name: `Restore into ${REF}` }).click();
  await expect(page).toHaveURL(new RegExp(`/_hs/projects/${REF}\\?restored$`));
  await expect(page.getByText("Backup restored.")).toBeVisible();

  const rows = await onPooler(session, async (client) => {
    const result = await client.query("select id, body from public.notes order by id");
    return result.rows;
  });
  expect(rows).toEqual([{ id: 1, body: "kept by a backup" }]);
});
