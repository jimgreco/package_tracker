-- Track the member who authorizes future exports. Do not guess ownership of
-- legacy grants; member removal disconnects those until an active member reconnects.
ALTER TABLE google_connections ADD COLUMN connected_by uuid;
ALTER TABLE google_connections ADD CONSTRAINT google_connection_membership
  FOREIGN KEY(household_id,connected_by)
  REFERENCES household_members(household_id,user_id) ON DELETE CASCADE;

-- Retain claimed consent until completion so disconnect can cancel token
-- exchanges already in flight, while callbacks remain single-use.
ALTER TABLE oauth_states ADD COLUMN claimed_at timestamptz;
