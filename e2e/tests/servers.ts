// The test server that `playwright.config.ts` starts: the release build of
// `crates/server/examples/e2e_server.rs` over the fake Google services.
//
// `mise run test:e2e` (scripts/e2e-run) gives each run its own port, output
// directory, and database, so two runs do not share a server or a file.
import path from "node:path"

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; run the journeys with 'mise run test:e2e'`)
  }
  return value
}

export const PORT = Number(required("E2E_PORT"))
export const BASE_URL = `http://127.0.0.1:${String(PORT)}`
export const DATABASE_URL = required("E2E_DATABASE_URL")

// The Playwright results of this run.
export const OUTPUT_DIR = path.resolve(required("E2E_OUTPUT_DIR"))

// The signed-in browser state that the setup project writes.
export const STORAGE_STATE = path.join(OUTPUT_DIR, ".auth/state.json")
