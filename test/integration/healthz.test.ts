import { expect, it } from "vitest";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";

it("serves /_hs/healthz through the published port", async () => {
  const response = await fetch(`${baseUrl}/_hs/healthz`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
