// The test server that `playwright.config.ts` starts: the release build of
// `crates/server/examples/e2e_server.rs` over the fake Google services.
export const PORT = 47411
export const BASE_URL = `http://127.0.0.1:${String(PORT)}`

// The signed-in browser state that the setup project writes.
export const STORAGE_STATE = "test-results/.auth/state.json"
