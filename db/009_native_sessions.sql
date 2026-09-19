-- Native sign-in is distinct from browser sessions and provider grants.
CREATE TABLE native_login_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 purpose text NOT NULL DEFAULT 'native_login' CHECK (purpose='native_login'),
 launch_hash text UNIQUE NOT NULL,
 app_state text NOT NULL,
 challenge text NOT NULL,
 browser_hash text,
 started_at timestamptz,
 user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 code_hash text UNIQUE,
 code_expires_at timestamptz,
 consumed_at timestamptz,
 expires_at timestamptz NOT NULL
);
ALTER TABLE google_signin_states ADD COLUMN native_attempt_id uuid REFERENCES native_login_attempts(id) ON DELETE CASCADE;
CREATE TABLE native_sessions (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX native_sessions_user ON native_sessions(user_id);
CREATE TABLE manual_create_attempts (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 route text NOT NULL CHECK (route='shipments'),
 key text NOT NULL,
 body_hash text NOT NULL,
 shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id, household_id, route, key)
);
