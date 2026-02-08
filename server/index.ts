import { startServer } from "./app"

startServer().catch((error) => {
  console.error("Startup failed:", error)
  process.exit(1)
})
