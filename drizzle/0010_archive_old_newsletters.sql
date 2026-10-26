-- Every newsletter in the table until now was carried from an old site, which
-- kept no record of whether an issue was sent, and the migration wrote them all
-- as "draft". No path in the app could create one before this release, so every
-- "draft" here is one of those: they are history, not work in progress.
UPDATE "newsletters" SET "status" = 'archived' WHERE "status" = 'draft' AND "sent_at" IS NULL;
