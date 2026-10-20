import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { seedAdmin } from "./auth/seed.js";
import { seedSharedBox } from "./boxes/shared.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { openRegistry, type Registry } from "./registry/db.js";
import { deriveSecretKey } from "./registry/secrets.js";

// HATTISAR_PORT is the host-published port; compose maps it onto this fixed container port.
const LISTEN_PORT = 8000;

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
    return registry;
  } catch (error) {
    registry.close();
    exitOnConfigError(error);
  }
}

const config = configOrExit();
const registry = await seededRegistry(config);
const app = createApp(config, registry);
const server = serve({ fetch: app.fetch, port: LISTEN_PORT }, (info) => {
  console.log(`hattisar listening on :${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () =>
    server.close(() => {
      registry.close();
      process.exit(0);
    }),
  );
}
