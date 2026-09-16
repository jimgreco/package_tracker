ALTER TABLE shipments ADD COLUMN IF NOT EXISTS retailer_reference text;
CREATE INDEX IF NOT EXISTS shipments_retailer_reference ON shipments(household_id,retailer_reference) WHERE retailer_reference IS NOT NULL;
