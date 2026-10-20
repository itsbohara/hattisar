import type { FullConfig } from "@playwright/test";
import { prepareSpikeStack } from "../test/spike-stack.js";
import { saveAdminSession } from "./helpers.js";

export default async function globalSetup(config: FullConfig): Promise<void> {
  prepareSpikeStack();
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("playwright.config.ts must set use.baseURL");
  await saveAdminSession(baseURL);
}
