import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { type Config, ConfigError, loadConfig } from "./config.js";

// HATTISAR_PORT is the host-published port; compose maps it onto this fixed container port.
const LISTEN_PORT = 8000;

function configOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`hattisar: invalid configuration: ${error.message}`);
    process.exit(1);
  }
}

const app = createApp(configOrExit());
const server = serve({ fetch: app.fetch, port: LISTEN_PORT }, (info) => {
  console.log(`hattisar listening on :${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
