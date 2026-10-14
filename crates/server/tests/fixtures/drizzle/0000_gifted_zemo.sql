CREATE TABLE IF NOT EXISTS "user_sessions" (
        "sid" varchar PRIMARY KEY NOT NULL,
        "sess" json NOT NULL,
        "expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_settings" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar NOT NULL,
        "calendar_id" text,
        "work_start_hour" integer DEFAULT 9 NOT NULL,
        "work_end_hour" integer DEFAULT 17 NOT NULL,
        "timezone" text DEFAULT 'America/New_York' NOT NULL,
        "default_duration" integer DEFAULT 60 NOT NULL,
        "event_color" text DEFAULT '1' NOT NULL,
        CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "google_id" text NOT NULL,
        "email" text NOT NULL,
        "display_name" text NOT NULL,
        "access_token" text,
        "refresh_token" text,
        CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_settings_user_id_users_id_fk') THEN
    ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;