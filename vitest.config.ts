import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts runs as a subprocess in test/e2e.test.ts, which v8 can't instrument;
      // prompt.ts needs an interactive terminal.
      exclude: ["src/index.ts", "src/prompt.ts", "src/types.ts"],
      reporter: ["text", "html"],
      thresholds: { lines: 85, functions: 85, branches: 70, statements: 85 },
    },
  },
});
