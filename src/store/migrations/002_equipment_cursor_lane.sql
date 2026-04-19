ALTER TABLE equipment_cursors ADD COLUMN lane TEXT;

UPDATE meta
   SET value = '2'
 WHERE key = 'schema_version';
