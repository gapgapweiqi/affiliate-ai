/**
 * Daily captions — keeps the photo-post queue fed.
 *
 * Promo Hunter only writes captions when a price moves, and with sparse
 * price history that rarely happens, so auto-publish often had nothing to
 * post. Once a day (07:30 BKK, before the 08:10 first post) this gives the
 * top-scoring products without an approved Facebook caption a fresh set
 * (3 angles, Quality Gate), until DAILY_CAPTION_PRODUCTS products succeed.
 *
 * Promos still jump the line: auto-publish orders "promo in the last 6 h"
 * before final_score, and promo-trigger writes their captions every 30 min.
 */

import { sql } from "drizzle-orm";
import { generateVariants } from "../content/variant-generator.ts";
import { db } from "../lib/db.ts";
import { child } from "../lib/logger.ts";
import { errMsg } from "../lib/retry.ts";

const log = child("brain.daily-captions");

export interface DailyCaptionsResult {
  productsTried: number;
  productsWithCaption: number;
  variantsApproved: number;
  totalCostUsd: number;
}

/**
 * Candidates in the order they're tried. Keep in sync with the dashboard's
 * getCaptionCandidates (src/dashboard/lib/queries.ts).
 */
export async function captionCandidates(limit: number): Promise<number[]> {
  const rows = await db.execute<{ id: number; [k: string]: unknown }>(sql`
    SELECT p.id FROM products p
    WHERE p.is_active AND NOT p.flag_blacklisted
      AND p.primary_image LIKE 'https://%'
      AND COALESCE(p.final_score, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM content_variants cv
                      WHERE cv.product_id = p.id AND cv.channel = 'facebook'
                        AND cv.gate_approved AND cv.is_active)
      AND NOT EXISTS (SELECT 1 FROM published_posts pp
                      WHERE pp.product_id = p.id AND pp.channel = 'facebook' AND pp.status = 'published'
                        AND pp.published_at > NOW() - INTERVAL '24 hours')
    ORDER BY p.final_score DESC, p.first_seen_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => r.id);
}

export async function runDailyCaptions(opts: { count?: number } = {}): Promise<DailyCaptionsResult> {
  const count = opts.count ?? 5;
  // Try a few extra in case some captions fail the gate.
  const candidates = await captionCandidates(count * 2);
  const result: DailyCaptionsResult = { productsTried: 0, productsWithCaption: 0, variantsApproved: 0, totalCostUsd: 0 };

  for (const productId of candidates) {
    if (result.productsWithCaption >= count) break;
    result.productsTried++;
    try {
      const r = await generateVariants({ productId, channel: "facebook" });
      result.totalCostUsd += r.totalCostUsd;
      result.variantsApproved += r.approved;
      if (r.approved > 0) result.productsWithCaption++;
      log.info({ productId, approved: r.approved, failed: r.failed }, "daily captions: product done");
    } catch (err) {
      log.error({ productId, err: errMsg(err) }, "daily captions: generation failed");
    }
  }

  log.info({ ...result, totalCostUsd: result.totalCostUsd.toFixed(4) }, "daily captions done");
  return result;
}
