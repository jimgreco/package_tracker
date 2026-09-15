ALTER TABLE users DROP CONSTRAINT users_signin_method;
ALTER TABLE users DROP COLUMN password_hash;
DROP TABLE invites;
-- Pending redirects from the older sign-in flow cannot be reused.
DELETE FROM google_signin_states;
ALTER TABLE google_signin_states DROP COLUMN purpose, DROP COLUMN user_id, DROP COLUMN registration_code, DROP COLUMN household_name;
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE google_subject IS NULL);
CREATE TABLE household_members (
 household_id uuid NOT NULL REFERENCES households(id),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK (role IN ('owner','member')),
 joined_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (household_id,user_id)
);
INSERT INTO household_members(household_id,user_id,role)
 SELECT household_id,id,CASE WHEN row_number() OVER (PARTITION BY household_id ORDER BY created_at,id)=1 THEN 'owner' ELSE 'member' END FROM users;
CREATE TABLE household_invitations (
 household_id uuid NOT NULL REFERENCES households(id),
 email text NOT NULL,
 added_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,email)
);
CREATE INDEX household_invitations_email ON household_invitations(email);
