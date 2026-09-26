CREATE TABLE "booking_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(24) NOT NULL,
	"order_id" uuid NOT NULL,
	"type" varchar(24) NOT NULL,
	"requester_kind" varchar(16) NOT NULL,
	"source" varchar(16) NOT NULL,
	"reason" text NOT NULL,
	"requested_outcome" text,
	"requested_change" jsonb,
	"state" varchar(16) DEFAULT 'open' NOT NULL,
	"outcome" varchar(24),
	"outcome_note" text,
	"refund_basis" varchar(16),
	"cancellation_id" uuid,
	"assignee_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_kind" varchar(16) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"request_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"resolve_key" uuid,
	"resolve_hash" varchar(64),
	CONSTRAINT "booking_case_valid_chk" CHECK ("booking_case"."type" IN ('owner_cancellation','customer_cancellation','change_request','no_show','late_arrival','operational')
    AND "booking_case"."requester_kind" IN ('customer','owner','admin') AND "booking_case"."source" IN ('portal','support','phone','email','internal')
    AND "booking_case"."created_by_kind" IN ('owner','admin') AND ("booking_case"."created_by_kind"='admin' OR ("booking_case"."requester_kind"='owner' AND "booking_case"."source"='portal'
      AND "booking_case"."type" IN ('owner_cancellation','no_show','late_arrival','operational')))
    AND length(trim("booking_case"."reason")) BETWEEN 10 AND 1000 AND ("booking_case"."requested_outcome" IS NULL OR length("booking_case"."requested_outcome") <= 500)
    AND "booking_case"."request_hash" ~ '^[a-f0-9]{64}$' AND "booking_case"."version" >= 1 AND "booking_case"."state" IN ('open','resolved')
    AND (("booking_case"."state"='open' AND "booking_case"."outcome" IS NULL AND "booking_case"."outcome_note" IS NULL AND "booking_case"."refund_basis" IS NULL AND "booking_case"."cancellation_id" IS NULL
        AND "booking_case"."resolved_at" IS NULL AND "booking_case"."resolved_by" IS NULL AND "booking_case"."resolve_key" IS NULL AND "booking_case"."resolve_hash" IS NULL)
      OR ("booking_case"."state"='resolved' AND "booking_case"."outcome" IN ('visits_cancelled','declined','no_change') AND length(trim("booking_case"."outcome_note")) BETWEEN 10 AND 1000
        AND "booking_case"."resolved_at" IS NOT NULL AND "booking_case"."resolved_by" IS NOT NULL AND "booking_case"."resolve_key" IS NOT NULL AND "booking_case"."resolve_hash" ~ '^[a-f0-9]{64}$'
        AND (("booking_case"."outcome"='visits_cancelled') = ("booking_case"."cancellation_id" IS NOT NULL))
        AND (("booking_case"."outcome"='visits_cancelled') = ("booking_case"."refund_basis" IN ('policy','full'))))))
);
--> statement-breakpoint
CREATE TABLE "booking_case_update" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"audience" varchar(16) NOT NULL,
	"body" text NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_key" uuid,
	CONSTRAINT "booking_case_update_valid_chk" CHECK ("booking_case_update"."kind" IN ('created','assigned','message','resolved')
    AND "booking_case_update"."audience" IN ('internal','client','customer','everyone') AND "booking_case_update"."actor_kind" IN ('owner','admin','system')
    AND length(trim("booking_case_update"."body")) BETWEEN 1 AND 2000 AND ("booking_case_update"."actor_kind"<>'owner' OR "booking_case_update"."audience"='client'))
);
--> statement-breakpoint
CREATE TABLE "booking_case_visit" (
	"case_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	CONSTRAINT "booking_case_visit_case_id_booking_id_pk" PRIMARY KEY("case_id","booking_id")
);
--> statement-breakpoint
ALTER TABLE "booking_case" ADD CONSTRAINT "booking_case_order_id_booking_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_case" ADD CONSTRAINT "booking_case_cancellation_id_booking_cancellation_id_fk" FOREIGN KEY ("cancellation_id") REFERENCES "public"."booking_cancellation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_case" ADD CONSTRAINT "booking_case_assignee_id_admin_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_case" ADD CONSTRAINT "booking_case_resolved_by_admin_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_case_update" ADD CONSTRAINT "booking_case_update_case_id_booking_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."booking_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_case_visit" ADD CONSTRAINT "booking_case_visit_case_id_booking_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."booking_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_case_visit" ADD CONSTRAINT "booking_case_visit_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_case_reference_idx" ON "booking_case" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_case_request_idx" ON "booking_case" USING btree ("created_by_kind","created_by_id","request_key");--> statement-breakpoint
CREATE INDEX "booking_case_queue_idx" ON "booking_case" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "booking_case_order_idx" ON "booking_case" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "booking_case_assignee_idx" ON "booking_case" USING btree ("assignee_id","state");--> statement-breakpoint
CREATE INDEX "booking_case_update_case_idx" ON "booking_case_update" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_case_update_request_idx" ON "booking_case_update" USING btree ("case_id","actor_kind","actor_id","request_key") WHERE "booking_case_update"."request_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "booking_case_visit_booking_idx" ON "booking_case_visit" USING btree ("booking_id");--> statement-breakpoint
-- CP14: a case changes only through assignment and one final resolution, each bumping its version.
CREATE TRIGGER booking_case_immutable BEFORE UPDATE OR DELETE ON booking_case FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','outcome','outcome_note','refund_basis','cancellation_id','assignee_id','version','updated_at','resolved_at','resolved_by','resolve_key','resolve_hash');
--> statement-breakpoint
CREATE TRIGGER booking_case_visit_immutable BEFORE UPDATE OR DELETE ON booking_case_visit FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE TRIGGER booking_case_update_immutable BEFORE UPDATE OR DELETE ON booking_case_update FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE FUNCTION rentra_case_owner(order_id uuid, actor uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM booking_order o JOIN rentable r ON r.id=o.rentable_id JOIN "user" u ON u.id=r.client_id
    WHERE o.id=order_id AND u.id=actor AND u.role='client' AND u.account_status='active')
$$;
--> statement-breakpoint
CREATE FUNCTION rentra_booking_case_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'open' OR NEW.version<>1 OR NEW.assignee_id IS NOT NULL
      OR (NEW.created_by_kind='owner' AND NOT rentra_case_owner(NEW.order_id, NEW.created_by_id))
      OR (NEW.created_by_kind='admin' AND NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.created_by_id AND is_active)) THEN
      RAISE EXCEPTION 'Invalid booking case scope' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='resolved' OR NEW.version<>OLD.version+1
    OR (NEW.assignee_id IS NOT NULL AND NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
      AND NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.assignee_id AND is_active))
    OR (NEW.state='resolved' AND NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.resolved_by AND is_active))
    OR (NEW.cancellation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_cancellation WHERE id=NEW.cancellation_id AND order_id=NEW.order_id)) THEN
    RAISE EXCEPTION 'Invalid booking case change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER booking_case_scope BEFORE INSERT OR UPDATE ON booking_case FOR EACH ROW EXECUTE FUNCTION rentra_booking_case_scope();
--> statement-breakpoint
CREATE FUNCTION rentra_booking_case_visit_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM booking_case c JOIN booking b ON b.order_id=c.order_id
    WHERE c.id=NEW.case_id AND b.id=NEW.booking_id AND c.state='open') THEN
    RAISE EXCEPTION 'Case visit must belong to the open case order' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER booking_case_visit_scope BEFORE INSERT ON booking_case_visit FOR EACH ROW EXECUTE FUNCTION rentra_booking_case_visit_scope();
--> statement-breakpoint
CREATE FUNCTION rentra_booking_case_update_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c booking_case;
BEGIN
  SELECT * INTO STRICT c FROM booking_case WHERE id=NEW.case_id;
  IF (NEW.actor_kind='owner' AND NOT rentra_case_owner(c.order_id, NEW.actor_id))
    OR (NEW.actor_kind='admin' AND NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.actor_id AND is_active))
    OR (NEW.actor_kind='system' AND NEW.actor_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid case update author' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER booking_case_update_scope BEFORE INSERT ON booking_case_update FOR EACH ROW EXECUTE FUNCTION rentra_booking_case_update_scope();
