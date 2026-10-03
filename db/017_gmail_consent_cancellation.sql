-- A claimed callback remains cancelable while its Google token exchange runs.
ALTER TABLE gmail_oauth_states ADD COLUMN claimed_at timestamptz;
