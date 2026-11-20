CREATE TABLE "affiliate_conversions" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" varchar(16) DEFAULT 'shopee' NOT NULL,
	"conversion_id" varchar(64) NOT NULL,
	"order_id" varchar(64) NOT NULL,
	"item_id" varchar(64) NOT NULL,
	"item_name" text,
	"qty" integer,
	"order_status" varchar(32),
	"commission_satang" bigint DEFAULT 0 NOT NULL,
	"amount_satang" bigint,
	"utm_content" varchar(255),
	"short_id" varchar(16),
	"affiliate_link_id" integer,
	"product_id" integer,
	"content_variant_id" integer,
	"purchased_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"raw" jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliate_conversions" ADD CONSTRAINT "affiliate_conversions_affiliate_link_id_affiliate_links_id_fk" FOREIGN KEY ("affiliate_link_id") REFERENCES "public"."affiliate_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_conversions" ADD CONSTRAINT "affiliate_conversions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_conversions" ADD CONSTRAINT "affiliate_conversions_content_variant_id_content_variants_id_fk" FOREIGN KEY ("content_variant_id") REFERENCES "public"."content_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_conversions_item_idx" ON "affiliate_conversions" USING btree ("platform","conversion_id","order_id","item_id");--> statement-breakpoint
CREATE INDEX "affiliate_conversions_purchased_idx" ON "affiliate_conversions" USING btree ("purchased_at");--> statement-breakpoint
CREATE INDEX "affiliate_conversions_product_idx" ON "affiliate_conversions" USING btree ("product_id");