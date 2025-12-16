import cron from "node-cron";
import { storage } from "./storage";
import { rescheduleAllUserTasks } from "./calendar";
import { db } from "./db";
import { users } from "@shared/schema";

export function setupCronJobs(baseUrl: string): void {
  cron.schedule("0 0 * * *", async () => {
    console.log("Running midnight reschedule job...");
    
    try {
      const allUsers = await db.select().from(users);
      
      for (const user of allUsers) {
        const settings = await storage.getUserSettings(user.id);
        if (settings?.calendarId) {
          console.log(`Rescheduling tasks for user ${user.id}`);
          await rescheduleAllUserTasks(user.id, baseUrl);
        }
      }
      
      console.log("Midnight reschedule job completed");
    } catch (error) {
      console.error("Error in midnight reschedule job:", error);
    }
  });

  console.log("Cron jobs initialized");
}
