CREATE TYPE "public"."land_unit" AS ENUM('vigha', 'var', 'acre', 'sqft');--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "farm_size" real;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "farm_size_unit" "land_unit";--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "pool_size" varchar(24);--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "check_in_from" varchar(32);--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "check_out_by" varchar(32);