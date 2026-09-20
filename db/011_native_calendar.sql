CREATE TABLE native_calendar_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 launch_hash text UNIQUE NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 session_hash text NOT NULL REFERENCES native_sessions(token_hash) ON DELETE CASCADE,
 app_state text NOT NULL,
 browser_hash text,
 started_at timestamptz,
 completed_at timestamptz,
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(household_id,user_id) REFERENCES household_members(household_id,user_id) ON DELETE CASCADE
);
ALTER TABLE oauth_states ADD COLUMN native_calendar_attempt_id uuid REFERENCES native_calendar_attempts(id) ON DELETE CASCADE;
