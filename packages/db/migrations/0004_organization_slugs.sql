-- no-transaction
-- Organization slugs are unique (case-insensitive: the column is citext). Built concurrently,
-- since organizations already has rows.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "organizations_slug" ON "organizations" USING btree ("slug");
-- The cleanup job's lookup of deleted organizations (the cleanup_job policy in 0003).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "organizations_deleted" ON "organizations" USING btree ("deleted_at") WHERE "deleted_at" IS NOT NULL;
