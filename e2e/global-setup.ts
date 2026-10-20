import type { FullConfig } from "@playwright/test";
import { prepareRoutingProjects } from "../test/helpers/projects.js";
import { saveAdminSession } from "./helpers.js";

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("playwright.config.ts must set use.baseURL");
  await prepareRoutingProjects(baseURL);
  await saveAdminSession(baseURL);
}
