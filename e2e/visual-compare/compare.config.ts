// One-off visual comparison of two client builds (not part of verify). The
// Rust port used it to prove that the web app looks the same as the old
// client (ADR 0004). Both builds run behind the same e2e test server.
//
// 1. Build the old client: `git worktree add <old> 6062e84`, then in <old>:
//    `pnpm install --frozen-lockfile && pnpm exec vite build` (the output is
//    <old>/dist/public).
// 2. Build the e2e server: `cargo build --release --locked -p caltodo --example e2e_server`.
// 3. Record the old screens on an empty database:
//    `BUILD=<old>/dist/public pnpm exec playwright test -c visual-compare/compare.config.ts --update-snapshots`
// 4. Empty the database again, then compare the new build:
//    `pnpm exec playwright test -c visual-compare/compare.config.ts`
//
// The snapshots are not committed (.gitignore). Expected result: every screen
// is identical (maxDiffPixels 0).
import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const PORT = process.env["PORT"] ?? "47431"
const BUILD = process.env["BUILD"] ?? path.join(ROOT, "web/build")
const DB =
  process.env["E2E_DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:55473/caltodo_visual"

export default defineConfig({
  testDir: ".",
  testMatch: /compare\.spec\.ts/,
  snapshotPathTemplate: "{testDir}/snapshots/{arg}{ext}",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    locale: "en-GB",
    timezoneId: "Europe/Helsinki",
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      threshold: 0,
      animations: "disabled",
      caret: "hide",
    },
  },
  webServer: {
    command: `"${path.join(ROOT, "target/release/examples/e2e_server")}" --port ${PORT} --web-build "${BUILD}" --database-url "${DB}"`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
  },
})
