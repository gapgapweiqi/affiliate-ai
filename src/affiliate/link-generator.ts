/**
 * Affiliate link generator (M8 — Sprint 1).
 *
 * Creates trackable short URLs in the form `https://{DOMAIN}/go/{shortId}`.
 * Each link is unique per (product × channel × variant) so we can attribute
 * clicks back to the exact content variant that drove them.
 *
 * Usage:
 *   const { shortUrl } = await createAffiliateLink({
 *     productId: 42,
 *     channel: "facebook",
 *     campaign: "morning_post_2026-05-03",
 *     variant: "A",
 *   });
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { shopeeApiConfigured, tryGenerateShortLink } from "./shopee-api.ts";

export type LinkMode = "shopee" | "redirect" | "direct";

/** Resolve LINK_MODE=auto against what's configured. */
export function linkMode(): LinkMode {
  if (env.LINK_MODE === "shopee") return "shopee";
  if (env.LINK_MODE === "redirect") return "redirect";
  if (shopeeApiConfigured()) return "shopee";
  return env.SITE_ENABLED ? "redirect" : "direct";
}

/** Shopee subIds must be plain alphanumerics; utmContent joins them with "-". */
function subId(v: string | null | undefined): string {
  return (v ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 50);
}

const log = child("affiliate.link-gen");

const SHORT_ID_LEN = 8;
const SHORT_ID_ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // base57 — no 0/O/1/l/I (visual confusion)
const MAX_COLLISION_RETRIES = 5;

export interface CreateAffiliateLinkOpts {
  productId: number;
  channel: typeof schema.channelEnum.enumValues[number];
  campaign?: string;
  variant?: string;
  /** FK to content_variants (M3 bandit feedback wires click → variant via this). */
  contentVariantId?: number;
  publishedPostId?: number;
  /** Override expiry (default: never expires). */
  expiresAt?: Date;
}

export interface AffiliateLinkResult {
  shortId: string;
  shortUrl: string;
  fullUrl: string;
  affiliateLinkId: number;
}

/**
 * Generate cryptographically random short ID using base57 alphabet.
 */
function generateShortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_ID_LEN * 2));
  let id = "";
  for (let i = 0; i < SHORT_ID_LEN; i++) {
    id += SHORT_ID_ALPHABET[bytes[i]! % SHORT_ID_ALPHABET.length];
  }
  return id;
}

/**
 * Build the destination URL — Shopee or TikTok Shop affiliate format.
 */
function buildDestinationUrl(opts: {
  platform: "shopee" | "tiktok_shop";
  externalId: string;
  shopExternalId: string | null;
  shortId: string; // used as af_sub1 for sub-tracking
}): string {
  const { platform, externalId, shopExternalId, shortId } = opts;

  if (platform === "shopee") {
    if (!shopExternalId) {
      throw new Error(`Shopee product ${externalId} missing shop external_id`);
    }
    const params = new URLSearchParams();
    params.set("af_sub1", shortId);
    if (env.SHOPEE_AFFILIATE_ID) params.set("af_id", env.SHOPEE_AFFILIATE_ID);
    if (env.SHOPEE_TRACKING_ID) params.set("af_sub_pub", env.SHOPEE_TRACKING_ID);
    return `https://shopee.co.th/product/${shopExternalId}/${externalId}?${params}`;
  }

  if (platform === "tiktok_shop") {
    if (!env.TIKTOK_SHOP_AFFILIATE_ID) {
      throw new Error("TIKTOK_SHOP_AFFILIATE_ID not configured");
    }
    const params = new URLSearchParams();
    params.set("utm_source", "affiliate");
    params.set("utm_medium", env.TIKTOK_SHOP_AFFILIATE_ID);
    params.set("utm_campaign", shortId);
    return `https://shop.tiktok.com/view/product/${externalId}?${params}`;
  }

  throw new Error(`Unsupported platform: ${platform satisfies never}`);
}

/**
 * Create a new trackable affiliate link for a product on a specific channel.
 */
export async function createAffiliateLink(
  opts: CreateAffiliateLinkOpts,
): Promise<AffiliateLinkResult> {
  // 1. Look up product
  const product = await db.query.products.findFirst({
    where: eq(schema.products.id, opts.productId),
    with: {
      // (no joins yet — fetch shop manually below)
    },
  });
  if (!product) throw new Error(`Product ${opts.productId} not found`);
  if (!product.isActive) throw new Error(`Product ${opts.productId} is inactive`);

  // 2. Look up shop external_id (we need it for Shopee URL)
  let shopExternalId: string | null = null;
  if (product.shopId) {
    const shop = await db.query.shops.findFirst({
      where: eq(schema.shops.id, product.shopId),
    });
    shopExternalId = shop?.externalId ?? null;
  }

  // 3. Generate unique shortId (retry on collision — extremely rare with 57^8)
  let shortId = "";
  let inserted = false;
  let attempts = 0;
  let result: { id: number } | undefined;
  let fullUrl = "";

  while (!inserted && attempts < MAX_COLLISION_RETRIES) {
    attempts++;
    shortId = generateShortId();
    fullUrl = buildDestinationUrl({
      platform: product.platform,
      externalId: product.externalId,
      shopExternalId,
      shortId,
    });

    try {
      const [row] = await db
        .insert(schema.affiliateLinks)
        .values({
          shortId,
          productId: product.id,
          channel: opts.channel,
          campaign: opts.campaign ?? null,
          variant: opts.variant ?? null,
          contentVariantId: opts.contentVariantId ?? null,
          publishedPostId: opts.publishedPostId ?? null,
          fullUrl,
          shopeeShortUrl: product.affiliateShortUrl ?? null,
          expiresAt: opts.expiresAt ?? null,
        })
        .returning({ id: schema.affiliateLinks.id });
      result = row;
      inserted = true;
    } catch (err: any) {
      // Postgres unique violation = collision; retry with new shortId
      if (err?.code === "23505" && attempts < MAX_COLLISION_RETRIES) continue;
      throw err;
    }
  }

  if (!result) throw new Error("Failed to insert affiliate link after retries");

  // subIds come back in Shopee's conversion report (utmContent), so the
  // report job can map a sale to this row via the shortId.
  const subIds = [opts.channel, shortId, subId(opts.campaign), subId(opts.variant)].filter(Boolean);
  const mode = linkMode();
  let shortUrl = `https://${env.DOMAIN_NAME}/go/${shortId}`;

  if (mode === "shopee" && product.platform === "shopee") {
    // Posts carry Shopee's own short link: commission-tracked, no domain or
    // redirect server needed. Generated before returning so the caption gets it.
    const shopeeLink = await tryGenerateShortLink({ originUrl: fullUrl, subIds });
    if (shopeeLink) {
      shortUrl = shopeeLink;
      await db.update(schema.affiliateLinks).set({ shopeeShortUrl: shopeeLink }).where(eq(schema.affiliateLinks.id, result.id));
    } else {
      shortUrl = env.SITE_ENABLED ? shortUrl : fullUrl;
      log.warn({ productId: product.id, shortId }, "Shopee short link failed — using fallback link");
    }
  } else if (mode === "direct") {
    shortUrl = fullUrl;
  } else if (product.platform === "shopee") {
    // redirect mode: keep /go/ for our click tracking, and attach a Shopee
    // short link in the background so the redirect lands on a tracked URL.
    void tryAttachShopeeShortLink({ affiliateLinkId: result.id, originUrl: fullUrl, subIds });
  }

  log.info({ productId: product.id, channel: opts.channel, shortId, shortUrl, mode }, "affiliate link created");
  return { shortId, shortUrl, fullUrl, affiliateLinkId: result.id };
}

/**
 * Async, fire-and-forget: ask Shopee Open API for a shope.ee/xxx short
 * link and patch it onto the affiliate_links row. Failures are logged
 * but never propagate — the row exists either way and the click path
 * has a fallback.
 */
async function tryAttachShopeeShortLink(opts: {
  affiliateLinkId: number;
  originUrl: string;
  subIds: string[];
}): Promise<void> {
  const shortLink = await tryGenerateShortLink({
    originUrl: opts.originUrl,
    subIds: opts.subIds,
  });
  if (!shortLink) return;
  try {
    await db
      .update(schema.affiliateLinks)
      .set({ shopeeShortUrl: shortLink })
      .where(eq(schema.affiliateLinks.id, opts.affiliateLinkId));
    log.info({ affiliateLinkId: opts.affiliateLinkId, shortLink }, "shp.ee attached");
  } catch (err) {
    log.warn({ affiliateLinkId: opts.affiliateLinkId, err: err instanceof Error ? err.message : String(err) }, "shp.ee patch failed");
  }
}

/**
 * Look up an existing affiliate link by shortId. Returns null if not found or expired.
 */
export async function lookupAffiliateLink(shortId: string) {
  const link = await db.query.affiliateLinks.findFirst({
    where: eq(schema.affiliateLinks.shortId, shortId),
  });
  if (!link) return null;
  if (!link.isActive) return null;
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return null;
  return link;
}
