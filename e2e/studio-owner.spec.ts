import { expect, test } from "@playwright/test";
import pg from "pg";
import { connectionStrings, postQuery } from "../test/helpers/projects.js";
import { signIn } from "../test/helpers/session.js";

const REF = "spike-b";
const TABLE = "made_in_studio";

test("a table created in Studio's Table Editor belongs to the project's owner", async ({
  page,
  baseURL,
}) => {
  const cookie = await signIn(baseURL as string);
  await postQuery(baseURL as string, cookie, REF, `drop table if exists public.${TABLE}`);

  await page.goto(`/project/${REF}/editor`);
  await page.getByRole("button", { name: "New table" }).click();
  await page.locator("input#name").fill(TABLE);
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(
    page.getByTestId("tables-list").getByRole("button", { name: `View ${TABLE}`, exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  const [session] = await connectionStrings(baseURL as string, cookie, REF);
  const client = new pg.Client({ connectionString: session, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query(`insert into public.${TABLE} default values`);
    const { rows } = await client.query(
      `select current_user, (select tableowner from pg_tables where tablename = $1) as owner,
              (select count(*)::int from public.${TABLE}) as count`,
      [TABLE],
    );
    expect(rows).toEqual([
      { current_user: "hs_spike_b_owner", owner: "hs_spike_b_owner", count: 1 },
    ]);
  } finally {
    await client.end();
    await postQuery(baseURL as string, cookie, REF, `drop table if exists public.${TABLE}`);
  }
});
