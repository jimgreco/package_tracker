ALTER TABLE shipments ADD COLUMN collected_at timestamptz;
ALTER TABLE shipments ADD COLUMN collected_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE shipments ADD COLUMN collected_by_name text;

CREATE TABLE notification_preferences (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 out_for_delivery boolean NOT NULL DEFAULT true,
 delivered boolean NOT NULL DEFAULT true,
 pickup boolean NOT NULL DEFAULT true,
 problems boolean NOT NULL DEFAULT true,
 PRIMARY KEY(user_id, household_id),
 FOREIGN KEY(household_id,user_id) REFERENCES household_members(household_id,user_id) ON DELETE CASCADE
);
CREATE TABLE push_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_hash text NOT NULL REFERENCES native_sessions(token_hash) ON DELETE CASCADE,
 token text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(token,environment)
);
CREATE TABLE push_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 device_id uuid NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
 household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
 category text NOT NULL,
 event_key text NOT NULL,
 message text NOT NULL,
 status text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(device_id,event_key)
);
CREATE INDEX push_deliveries_pending ON push_deliveries(created_at) WHERE status='pending';
-- Capture real transitions transactionally, including multiple updates between worker polls.
CREATE FUNCTION shipment_push_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category text;
BEGIN
 IF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW; END IF;
 IF NEW.is_demo OR NEW.archived_at IS NOT NULL OR NEW.dismissed_at IS NOT NULL OR NEW.collected_at IS NOT NULL OR NEW.status_at < now()-interval '24 hours' THEN RETURN NEW; END IF;
 category := CASE NEW.status WHEN 'out_for_delivery' THEN 'out_for_delivery' WHEN 'delivered' THEN 'delivered' WHEN 'available_for_pickup' THEN 'pickup' WHEN 'failure' THEN 'problems' WHEN 'delayed' THEN 'problems' WHEN 'return_to_sender' THEN 'problems' END;
 IF category IS NULL THEN RETURN NEW; END IF;
 INSERT INTO push_deliveries(device_id,household_id,shipment_id,category,event_key,message)
 SELECT d.id,NEW.household_id,NEW.id,category,NEW.id||':'||NEW.status||':'||NEW.version,
 CASE NEW.status WHEN 'out_for_delivery' THEN 'A package is out for delivery.' WHEN 'delivered' THEN 'A package was delivered.' WHEN 'available_for_pickup' THEN 'A package is ready for pickup.' WHEN 'delayed' THEN 'A package has been delayed.' WHEN 'return_to_sender' THEN 'A package is returning to sender.' ELSE 'A package has a delivery problem.' END
 FROM push_devices d JOIN native_sessions n ON n.token_hash=d.session_hash AND n.expires_at>now()
 JOIN notification_preferences p ON p.user_id=d.user_id AND p.household_id=NEW.household_id
 WHERE p.enabled AND CASE category WHEN 'out_for_delivery' THEN p.out_for_delivery WHEN 'delivered' THEN p.delivered WHEN 'pickup' THEN p.pickup ELSE p.problems END
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER shipment_push_transition AFTER INSERT OR UPDATE OF status ON shipments FOR EACH ROW EXECUTE FUNCTION shipment_push_transition();
CREATE TABLE shipment_attention_state (
 shipment_id uuid PRIMARY KEY REFERENCES shipments(id) ON DELETE CASCADE,
 reasons text[] NOT NULL DEFAULT '{}',
 generation bigint NOT NULL DEFAULT 0
);
