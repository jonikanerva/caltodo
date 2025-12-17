CREATE INDEX IF NOT EXISTS tasks_user_completed_priority_idx
  ON tasks (user_id, completed, priority);

CREATE INDEX IF NOT EXISTS tasks_calendar_event_idx
  ON tasks (calendar_event_id);
