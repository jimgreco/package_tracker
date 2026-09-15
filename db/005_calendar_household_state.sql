-- A calendar connection must finish in the household where it started.
DELETE FROM oauth_states;
ALTER TABLE oauth_states ADD COLUMN household_id uuid NOT NULL REFERENCES households(id);
