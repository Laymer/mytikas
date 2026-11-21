ALTER TABLE blacklist_warnings ADD COLUMN withdrawn_at timestamptz;

-- Preserve unsent warnings for audit when every source report was corrected.
UPDATE blacklist_warnings w
SET withdrawn_at = (SELECT max(r.voided_at) FROM blacklist_reports r WHERE r.character_key=w.character_key)
WHERE w.delivered_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM blacklist_reports r WHERE r.character_key=w.character_key AND r.voided_at IS NULL);
