import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // The routing spec reads hattisar's process-wide pg-meta log; a parallel test's requests would
  // land in its window and fail it.
  workers: 1,
  use: {
    baseURL: process.env.HATTISAR_URL ?? "http://localhost:8000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
