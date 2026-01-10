import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"
import * as schema from "@shared/schema"
import path from "path"

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?")
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const db = drizzle(pool, { schema })

export async function runMigrations() {
  console.log("Running database migrations...")
  try {
    const migrationsFolder =
      process.env.NODE_ENV === "production"
        ? path.join(process.cwd(), "dist", "migrations")
        : path.join(process.cwd(), "migrations")

    await migrate(db, { migrationsFolder })
    console.log("Database migrations completed successfully")
  } catch (error) {
    console.error("Migration error:", error)
    throw error
  }
}
