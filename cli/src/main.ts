#!/usr/bin/env node
import { defaultConfigDir } from "./config.js";
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2), {
  fetch: (request) => fetch(request),
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  configDir: defaultConfigDir(process.env),
});
