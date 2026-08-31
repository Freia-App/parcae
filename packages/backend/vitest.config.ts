import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // The Postgres-gated files share one server; parallel files race
    // its connection budget and the migrations CLI's subprocesses.
    // Without the env var those files skip and full parallelism holds.
    fileParallelism: !process.env.PARCAE_TEST_DATABASE_URL,
  },
});
