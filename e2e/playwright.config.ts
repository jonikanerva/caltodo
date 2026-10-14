// The browser journeys of `mise run test:e2e` (STACK.md §11 and §14).
//
// One deterministic test server runs the release build of
// `crates/server/examples/e2e_server.rs`: the real router, middleware, and
// client build over the fake Google services, on the PostgreSQL database of
// `E2E_DATABASE_URL`, which `mise run test:e2e` creates empty.
//
// The journeys run one at a time against one fake account: the server keeps
// its real rate limits (25 sign-ins per 15 minutes per client), so the setup
// project signs in once and the other projects reuse its session.
import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BASE_URL, PORT, STORAGE_STATE } from "./tests/servers.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SERVER = path.join(ROOT, "target/release/examples/e2e_server")
const WEB_BUILD = path.join(ROOT, "web/build")
const DATABASE_URL =
  process.env["E2E_DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:55473/caltodo_e2e"

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  forbidOnly: true,
  // A failure is investigated, never retried away (DOCTRINE.md P6).
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    locale: "en-GB",
    timezoneId: "Europe/Helsinki",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop-chromium",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
    },
    {
      name: "mobile-chromium",
      dependencies: ["desktop-chromium"],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices["Pixel 7"], storageState: STORAGE_STATE },
    },
  ],
  webServer: {
    command: `"${SERVER}" --port ${String(PORT)} --web-build "${WEB_BUILD}" --database-url "${DATABASE_URL}"`,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
})
