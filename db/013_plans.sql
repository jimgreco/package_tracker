ALTER TABLE households ADD COLUMN plan text NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free','paid'));
ALTER TABLE users ADD COLUMN platform_admin boolean NOT NULL DEFAULT false;

-- Initial complimentary accounts. Future households remain free until changed by an admin.
UPDATE households h SET plan='paid'
WHERE EXISTS (
  SELECT 1 FROM household_members m JOIN users u ON u.id=m.user_id
  WHERE m.household_id=h.id AND u.google_subject IS NOT NULL
    AND lower(coalesce(u.google_email,u.email))
    IN ('jgreco@gmail.com','rachel.ingwer@gmail.com')
);
UPDATE users SET platform_admin=true
WHERE lower(coalesce(google_email,email))='jgreco@gmail.com' AND google_subject IS NOT NULL;

UPDATE shipments SET tracking_state='none' WHERE household_id IN
  (SELECT id FROM households WHERE plan='free') AND is_demo=false;
UPDATE gmail_connections SET enabled=false,generation=gen_random_uuid()::text
WHERE household_id IN (SELECT id FROM households WHERE plan='free');
UPDATE jobs SET status='done',error=NULL WHERE status IN ('pending','dead')
  AND kind IN ('gmail_sync','track_register','track_refresh','track_webhook')
  AND payload->>'householdId' IN (SELECT id::text FROM households WHERE plan='free');
