import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { serve } from "@hono/node-server";
import { backupDeps, createApp, poolerTenants, projectServiceDeps } from "./app.js";
import { seedAdmin } from "./auth/seed.js";
import { removeStaleRestoreDirs } from "./backups/restore.js";
import { runScheduledBackups } from "./backups/scheduled.js";
import { failInterruptedBackups } from "./backups/service.js";
import { seedSharedBox } from "./boxes/shared.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { Scheduler } from "./jobs.js";
import { createManagedBoxes, type ManagedBoxes } from "./managed/service.js";
import type { PoolerTenants } from "./pooler/tenants.js";
import { purgeExpiredProjects } from "./projects/lifecycle.js";
import { deleteExpiredApiTokens } from "./registry/api-tokens.js";
import { openRegistry, type Registry } from "./registry/db.js";
import { deriveSecretKey } from "./registry/secrets.js";
import { deleteExpiredSessions } from "./registry/sessions.js";
import { importStudioSnippets } from "./snippets/import.js";

// HATTISAR_PORT is the host-published port; compose maps it onto this fixed container port.
const LISTEN_PORT = 8000;
const STUDIO_SNIPPETS_DIR = "/studio-snippets";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// Node gives each address of a dual-stack host 250 ms by default, shorter than the round trip to a
// box in another region, so every attempt times out (a cloud box looks unreachable while psql works).
const ADDRESS_ATTEMPT_TIMEOUT_MS = 2_000;

function exitOnConfigError(error: unknown): never {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`hattisar: invalid configuration: ${error.message}`);
  process.exit(1);
}

function configOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    exitOnConfigError(error);
  }
}

async function seededRegistry(config: Config): Promise<Registry> {
  const registry = openRegistry(config.dataDir);
  try {
    await seedAdmin(registry, config);
    seedSharedBox(registry, config, deriveSecretKey(config.secretKey));
    failInterruptedBackups(registry);
    await removeStaleRestoreDirs(config.dataDir);
    return registry;
  } catch (error) {
    registry.close();
    exitOnConfigError(error);
  }
}

// A failed import must not keep hattisar down; without the marker it runs again on the next boot.
function importSharedSnippets(registry: Registry): void {
  try {
    const counts = importStudioSnippets(registry, STUDIO_SNIPPETS_DIR);
    if (!counts) return;
    if (!counts.found) {
      console.log(`hattisar: no Studio snippets at ${STUDIO_SNIPPETS_DIR}; nothing imported`);
      return;
    }
    console.log(
      `hattisar: imported ${counts.snippets} snippets and ${counts.folders} folders from Studio into ${counts.projects} projects`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`hattisar: could not import Studio's snippets, retrying next boot: ${message}`);
  }
}

function managedBoxesOrExit(
  config: Config,
  registry: Registry,
  pooler: PoolerTenants,
): ManagedBoxes | undefined {
  try {
    return createManagedBoxes(config, registry, deriveSecretKey(config.secretKey), pooler);
  } catch (error) {
    registry.close();
    exitOnConfigError(error);
  }
}

setDefaultAutoSelectFamilyAttemptTimeout(ADDRESS_ATTEMPT_TIMEOUT_MS);
const config = configOrExit();
const registry = await seededRegistry(config);
importSharedSnippets(registry);
const pooler = poolerTenants(config, registry);
const managed = managedBoxesOrExit(config, registry, pooler);
const app = createApp(config, registry, managed, pooler);
const scheduler = new Scheduler();
const projectDeps = projectServiceDeps(config, registry, managed);
scheduler.register("purge-deleted-projects", HOUR_MS, (now) =>
  purgeExpiredProjects(projectDeps, config.purgeAfterDays, now),
);
scheduler.register("purge-expired-sessions", HOUR_MS, async (now) =>
  deleteExpiredSessions(registry, now.toISOString()),
);
scheduler.register("purge-expired-api-tokens", HOUR_MS, async (now) =>
  deleteExpiredApiTokens(registry, now.toISOString()),
);
const scheduledBackupDeps = backupDeps(config, registry);
scheduler.register("scheduled-backups", MINUTE_MS, (now) =>
  runScheduledBackups(scheduledBackupDeps, now),
);
scheduler.register("reconcile-pooler-tenants", 10 * MINUTE_MS, () => pooler.reconcile());
scheduler.start();
const server = serve({ fetch: app.fetch, port: LISTEN_PORT }, (info) => {
  console.log(`hattisar listening on :${info.port}`);
});
void pooler.reconcile().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`hattisar: pooler tenant reconcile failed: ${message}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () =>
    server.close(() => {
      scheduler.stop();
      registry.close();
      process.exit(0);
    }),
  );
}
