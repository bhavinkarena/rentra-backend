-- Hand-edited from the generated version, which added a NOT NULL column with
-- no default and would have failed on a table that already has rows.
-- Safe order: add nullable -> backfill -> constrain.

ALTER TABLE "rentable" ADD COLUMN "public_code" varchar(10);--> statement-breakpoint

UPDATE "rentable"
   SET "public_code" = substr(md5(random()::text || "id"::text), 1, 8)
 WHERE "public_code" IS NULL;--> statement-breakpoint

ALTER TABLE "rentable" ALTER COLUMN "public_code" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "rentable" ADD CONSTRAINT "rentable_public_code_unique" UNIQUE("public_code");
