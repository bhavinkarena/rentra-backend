CREATE TABLE "customer_favourite" (
	"customer_id" uuid NOT NULL,
	"rentable_id" uuid NOT NULL,
	"selection" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_favourite_customer_id_rentable_id_pk" PRIMARY KEY("customer_id","rentable_id")
);
--> statement-breakpoint
CREATE TABLE "customer_favourite_merge" (
	"customer_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_favourite_merge_customer_id_entry_id_pk" PRIMARY KEY("customer_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "customer_favourite" ADD CONSTRAINT "customer_favourite_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_favourite_merge" ADD CONSTRAINT "customer_favourite_merge_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;