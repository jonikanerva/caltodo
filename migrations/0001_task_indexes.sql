DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'tasks'
  ) THEN
    CREATE INDEX IF NOT EXISTS tasks_user_completed_priority_idx
      ON tasks (user_id, completed, priority);

    CREATE INDEX IF NOT EXISTS tasks_calendar_event_idx
      ON tasks (calendar_event_id);
  END IF;
END $$;
