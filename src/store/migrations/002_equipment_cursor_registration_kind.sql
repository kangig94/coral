ALTER TABLE equipment_cursors
  ADD COLUMN registration_kind TEXT NOT NULL DEFAULT 'base';

UPDATE equipment_cursors
   SET registration_kind = 'base'
 WHERE registration_kind IS NULL;

UPDATE meta
   SET value = '2'
 WHERE key = 'schema_version';
