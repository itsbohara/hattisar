-- The bucket a backup was written to, so deleting or restoring it still reaches the object after
-- the S3 settings change. NULL on rows from before this column: they use the configured bucket.
ALTER TABLE backups ADD COLUMN bucket TEXT;
