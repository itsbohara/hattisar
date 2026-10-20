import { defineConfig, devices } from "@playwright/test";
import { ADMIN_STORAGE_STATE } from "./e2e/helpers.js";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // The routing spec reads hattisar's process-wide pg-meta log; a parallel test's requests would
  // land in its window and fail it.
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.HATTISAR_URL ?? "http://localhost:8000",
    trace: "retain-on-failure",
    storageState: ADMIN_STORAGE_STATE,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
