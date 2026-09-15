ALTER TABLE shipments ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
