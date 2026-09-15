ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN google_subject text UNIQUE;
ALTER TABLE users ADD COLUMN google_email text;
ALTER TABLE users ADD CONSTRAINT users_signin_method CHECK (password_hash IS NOT NULL OR google_subject IS NOT NULL);

-- Sign-in state is separate from household Calendar authorization.
CREATE TABLE google_signin_states (
 state_hash text PRIMARY KEY,
 browser_hash text NOT NULL,
 verifier text NOT NULL,
 nonce_hash text NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('login','register','link')),
 user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 registration_code text,
 household_name text,
 expires_at timestamptz NOT NULL
);
