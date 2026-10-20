import { defineConfig } from "vitest/config";

const enabled = process.env.HATTISAR_IT === "1";

export default defineConfig({
  test: {
    include: enabled ? ["test/integration/**/*.test.ts"] : [],
    passWithNoTests: !enabled,
    testTimeout: 30_000,
  },
});
