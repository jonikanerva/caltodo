CREATE TABLE "action_tokens" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash" text NOT NULL UNIQUE,
  "user_id" varchar NOT NULL REFERENCES "users"("id"),
  "event_id" text NOT NULL,
  "calendar_id" text NOT NULL,
  "expires_at" timestamp(6) NOT NULL,
  "used_at" timestamp(6),
  "created_at" timestamp(6) NOT NULL DEFAULT now()
);

CREATE INDEX "action_tokens_user_id_idx" ON "action_tokens" ("user_id");
CREATE INDEX "action_tokens_event_id_idx" ON "action_tokens" ("event_id");
CREATE INDEX "action_tokens_calendar_id_idx" ON "action_tokens" ("calendar_id");
CREATE INDEX "action_tokens_expires_at_idx" ON "action_tokens" ("expires_at");
