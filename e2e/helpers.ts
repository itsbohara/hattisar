import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";
import { adminCredentials } from "../test/helpers/session.js";

export const ADMIN_STORAGE_STATE = fileURLToPath(new URL("./.auth/admin.json", import.meta.url));

// Every e2e test starts signed in as the stack's admin through this storage state.
export async function saveAdminSession(baseURL: string): Promise<void> {
  const context = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  try {
    const response = await context.post("/_hs/login", {
      form: { ...adminCredentials() },
      maxRedirects: 0,
    });
    if (response.status() !== 302) {
      throw new Error(`signing in for e2e failed with ${response.status()}`);
    }
    await context.storageState({ path: ADMIN_STORAGE_STATE });
  } finally {
    await context.dispose();
  }
}
