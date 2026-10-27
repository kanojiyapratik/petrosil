-- On the old sites "Published" only put a report or an impex sheet in the
-- list: the page with its file sat behind an `auth` + `premium` route group,
-- so every one of them was for paying readers. Carried as "published", which
-- here means open to everyone, the new paid download would have given all
-- 3,628 reports and 5,531 impex sheets away. They were sold as subscribers-
-- only, so that is what they are; making one free is now a deliberate choice
-- in the editor (a sample, say). A sample report is left as it is.
UPDATE "reports" SET "status" = 'premium' WHERE "status" = 'published' AND "report_type" <> 'sample';--> statement-breakpoint
UPDATE "impex_sheets" SET "status" = 'premium' WHERE "status" = 'published';
