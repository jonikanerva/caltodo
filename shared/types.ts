export interface CalendarTask {
  id: string;
  title: string;
  details: string | null;
  duration: number | null;
  reminderMinutes: number | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  completed: boolean;
  completedAt: string | null;
  priority: number;
}

