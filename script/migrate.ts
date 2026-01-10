import { runMigrations } from "../server/db"

runMigrations()
  .then(() => {
    console.log("Migrations finished.")
    process.exit(0)
  })
  .catch((error) => {
    console.error("Migration failed:", error)
    process.exit(1)
  })
