CREATE TABLE gmail_oauth_states (
 state_hash text PRIMARY KEY, browser_hash text NOT NULL, verifier text NOT NULL, nonce_hash text NOT NULL,
 user_id uuid NOT NULL, household_id uuid NOT NULL, import_since timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(household_id,user_id) REFERENCES household_members(household_id,user_id) ON DELETE CASCADE
);
CREATE TABLE gmail_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, household_id uuid NOT NULL,
 google_subject text NOT NULL, email text NOT NULL, refresh_token text NOT NULL, generation text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, needs_reconnect boolean NOT NULL DEFAULT false,
 import_since timestamptz NOT NULL, scan_after timestamptz NOT NULL, scan_before timestamptz, page_token text,
 next_sync_at timestamptz NOT NULL DEFAULT now(), last_synced_at timestamptz, error text,
 imported_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(household_id,user_id) REFERENCES household_members(household_id,user_id) ON DELETE CASCADE
);
ALTER TABLE source_emails ADD COLUMN source text NOT NULL DEFAULT 'Forwarded email';
