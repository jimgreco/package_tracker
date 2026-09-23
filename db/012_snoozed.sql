ALTER TABLE shipments ADD COLUMN snoozed_at timestamptz;

-- A newly associated source email wakes the package, including emails that
-- only add context without changing its status or estimate.
CREATE FUNCTION wake_shipment_on_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE shipments SET snoozed_at=NULL,updated_at=now()
 WHERE id=NEW.shipment_id AND snoozed_at IS NOT NULL
   AND archived_at IS NULL AND dismissed_at IS NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER shipment_email_wakes_snooze AFTER INSERT ON shipment_emails
FOR EACH ROW EXECUTE FUNCTION wake_shipment_on_email();
