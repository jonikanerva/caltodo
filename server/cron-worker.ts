import { setupCronJobs } from "./cron"

function getBaseUrl(): string {
  if (process.env.PRODUCTION_APP_URL) {
    return process.env.PRODUCTION_APP_URL
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`
  }
  return "http://localhost:5000"
}

setupCronJobs(getBaseUrl())
console.log("Cron worker started")
