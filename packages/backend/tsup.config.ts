import { defineConfig } from "tsup";

export default defineConfig({
  // `log` is its own entry so a test that mocks "@parcae/backend" whole
  // still gets the real logger; splitting puts it in one shared chunk, so
  // both entries use the same module.
  entry: ["src/index.ts", "src/log.ts", "src/cli/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "node",
  splitting: true,
  treeshake: true,
  // The CLI entry (src/cli/index.ts) starts with `#!/usr/bin/env node` —
  // tsup preserves that shebang on the compiled bin.
  external: [
    "@parcae/model",
    "knex",
    "socket.io",
    "bullmq",
    "ioredis",
  ],
});
