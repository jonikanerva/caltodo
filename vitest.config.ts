import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
      "client/src/**/*.test.ts",
      "client/src/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["server/**/*.ts", "shared/**/*.ts", "client/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "client/src/components/ui/**",
        "server/index.ts",
        "server/vite.ts",
      ],
      thresholds: {
        "server/handlers/taskRoutes.ts": {
          statements: 75,
          branches: 65,
          functions: 80,
          lines: 75,
        },
        "server/handlers/actionRoutes.ts": {
          statements: 68,
          branches: 60,
          functions: 70,
          lines: 68,
        },
        "server/calendar.ts": {
          statements: 20,
          branches: 20,
          functions: 20,
          lines: 20,
        },
      },
    },
  },
})
