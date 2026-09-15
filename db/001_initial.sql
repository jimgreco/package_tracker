CREATE TABLE IF NOT EXISTS households (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, time_zone text NOT NULL DEFAULT 'America/New_York',
 forwarding_token text UNIQUE NOT NULL, feed_token text UNIQUE NOT NULL, is_demo boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households(id), email text UNIQUE NOT NULL, name text NOT NULL,
 password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS invites (token_hash text PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, count int NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households(id), merchant text NOT NULL,
 merchant_key text NOT NULL, order_number text, ordered_at date, items jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(household_id, merchant_key, order_number)
);
CREATE TABLE IF NOT EXISTS source_emails (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households(id), message_key text NOT NULL,
 subject text NOT NULL, sender text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 body_text text NOT NULL DEFAULT '', body_html text NOT NULL DEFAULT '', links jsonb NOT NULL DEFAULT '[]', images jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','processed','needs_review','failed','ignored')),
 extraction jsonb, error text, UNIQUE(household_id,message_key)
);
CREATE TABLE IF NOT EXISTS assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households(id), storage_key text NOT NULL, content_type text NOT NULL, size int NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS shipments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households(id), order_id uuid NOT NULL REFERENCES orders(id),
 items jsonb NOT NULL DEFAULT '[]', carrier text, tracking_number text, tracking_url text,
 status text NOT NULL DEFAULT 'ordered' CHECK(status IN ('ordered','pre_transit','in_transit','out_for_delivery','delivered','available_for_pickup','delayed','failure','return_to_sender','cancelled','unknown')),
 shipped_at timestamptz, estimate jsonb, delivered_at timestamptz, status_at timestamptz NOT NULL DEFAULT now(), estimate_at timestamptz,
 tracker_id text, tracking_state text NOT NULL DEFAULT 'none', tracking_error text, last_checked_at timestamptz,
 needs_review boolean NOT NULL DEFAULT false, review_reason text, manual_override boolean NOT NULL DEFAULT false,
 is_demo boolean NOT NULL DEFAULT false, version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipments_household ON shipments(household_id,created_at DESC);
CREATE INDEX IF NOT EXISTS shipments_tracking ON shipments(household_id,tracking_number);
CREATE INDEX IF NOT EXISTS shipments_tracker ON shipments(tracker_id);
CREATE TABLE IF NOT EXISTS shipment_emails (shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,email_id uuid NOT NULL REFERENCES source_emails(id),PRIMARY KEY(shipment_id,email_id));
CREATE TABLE IF NOT EXISTS tracking_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
 event_key text NOT NULL, status text NOT NULL, message text NOT NULL, location text, occurred_at timestamptz NOT NULL,source text NOT NULL,
 UNIQUE(shipment_id,event_key)
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL,payload jsonb NOT NULL, dedupe_key text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','dead')),
 attempts int NOT NULL DEFAULT 0,run_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,lease_token uuid,error text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,run_at);
CREATE TABLE IF NOT EXISTS oauth_states (state_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),verifier text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS google_connections (
 household_id uuid PRIMARY KEY REFERENCES households(id), refresh_token text NOT NULL, calendar_id text,
 last_synced_at timestamptz, error text, generation text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calendar_events (
 shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,calendar_id text NOT NULL, event_id text NOT NULL,
 synced_version int NOT NULL DEFAULT 0,PRIMARY KEY(shipment_id,calendar_id)
);
CREATE TABLE IF NOT EXISTS service_health (name text PRIMARY KEY,last_seen_at timestamptz NOT NULL);
