// Runs the fixture generators against the Node server code. The generators
// write the golden fixtures and test vectors that the Rust tests read.
//
//   TZ=UTC FIXTURE_DATABASE_URL=postgres://... pnpm exec vitest run \
//     --config script/node-fixtures/vitest.config.ts
//
// The Rust server replaces the Node server. These generators need the Node
// server code, so they run only at the commit that adds them.
import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "..", "..", "shared"),
    },
  },
  test: {
    root: path.resolve(import.meta.dirname, "..", ".."),
    environment: "node",
    include: ["script/node-fixtures/**/*.fixtures.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
})
