import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vitest/config"

const root = path.dirname(fileURLToPath(import.meta.url))

// The dev server runs on port 5000, the origin of the Google OAuth redirect
// URI in development. It forwards the API and the action pages to the Rust
// server on port 5001 (`mise run dev`).
const server = "http://localhost:5001"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
    },
  },
  build: {
    outDir: "build",
    emptyOutDir: true,
  },
  server: {
    port: 5000,
    strictPort: true,
    proxy: {
      "/api": { target: server },
      "/action": { target: server },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
