/**
 * Product scorer — fills products.final_score (plus demand_score,
 * profitability_score, trend_velocity) so auto-publish, the web layer and
 * the dashboard can rank "which product is worth promoting".
 *
 * One set-based UPDATE over all active products. Signals that have no
 * natural scale (sold count, clicks, growth) are ranked against the current
 * pool with percent_rank(), so the score stays meaningful whatever niche or
 * price band the catalogue drifts into.
 *
 * Components (each 0..1)                           weight
 *   demand    — lifetime sold count (rank)           0.30
 *   quality   — Bayesian rating (prior 4.6★ × 30)    0.20
 *               (missing rating_count counts as 10)
 *   deal      — discount, capped at 60%              0.20
 *   velocity  — units sold in the last 7 days (rank) 0.10
 *   clicks    — our own /go/ clicks, 14 days (rank)  0.10
 *   shop      — shops.reliability_score              0.10
 *
 * Penalties (multiplied in): price < ฿20 or discount ≥ 90% (bait pricing)
 * ×0.3, regulated ×0.5, no image ×0.5.
 */

import { sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { child } from "../lib/logger.ts";

const log = child("brain.scorer");

export const SCORE_WEIGHTS = {
  demand: 0.3,
  quality: 0.2,
  deal: 0.2,
  velocity: 0.1,
  clicks: 0.1,
  shop: 0.1,
} as const;

export async function rescoreProducts(): Promise<{ scored: number }> {
  const w = SCORE_WEIGHTS;
  const rc = sql`(CASE WHEN p.rating IS NULL THEN 0 ELSE COALESCE(p.rating_count, 10) END)`;
  const res = await db.execute<{ id: number; [k: string]: unknown }>(sql`
    WITH sold_7d AS (
      SELECT product_id,
             GREATEST(0, MAX(sold_count) - MIN(sold_count)) AS delta
      FROM product_prices
      WHERE captured_at > NOW() - INTERVAL '7 days' AND sold_count IS NOT NULL
      GROUP BY product_id
    ),
    clicks_14d AS (
      SELECT al.product_id, COUNT(*) AS n
      FROM clicks c
      JOIN affiliate_links al ON al.id = c.affiliate_link_id
      WHERE c.clicked_at > NOW() - INTERVAL '14 days'
      GROUP BY al.product_id
    ),
    base AS (
      SELECT p.id,
        percent_rank() OVER (ORDER BY COALESCE(p.sold_count, 0))      AS demand,
        -- Apify's Shopee actor returns rating but not rating_count; treat a
        -- missing count as 10 reviews so the stars still move the score.
        LEAST(1, GREATEST(0,
          ((COALESCE(p.rating, 0) * ${rc} + 4.6 * 30) / (${rc} + 30) - 4.0) / 1.0)) AS quality,
        CASE WHEN COALESCE(p.discount_percent, 0) >= 0.9 THEN 0
             ELSE LEAST(COALESCE(p.discount_percent, 0), 0.6) / 0.6 END AS deal,
        percent_rank() OVER (ORDER BY COALESCE(s.delta, 0))           AS velocity,
        percent_rank() OVER (ORDER BY COALESCE(c.n, 0))               AS clicks,
        COALESCE(sh.reliability_score, 0.5)                           AS shop,
        (CASE WHEN COALESCE(p.current_price, 0) < 2000
                OR COALESCE(p.discount_percent, 0) >= 0.9 THEN 0.3 ELSE 1 END)
          * (CASE WHEN p.flag_regulated THEN 0.5 ELSE 1 END)
          * (CASE WHEN p.primary_image IS NULL THEN 0.5 ELSE 1 END)   AS penalty
      FROM products p
      LEFT JOIN sold_7d s ON s.product_id = p.id
      LEFT JOIN clicks_14d c ON c.product_id = p.id
      LEFT JOIN shops sh ON sh.id = p.shop_id
      WHERE p.is_active = true AND p.flag_blacklisted = false
    )
    UPDATE products p SET
      demand_score        = b.demand,
      profitability_score = b.deal,
      trend_velocity      = b.velocity * 2 - 1,
      final_score = ROUND((
          ${w.demand}   * b.demand
        + ${w.quality}  * b.quality
        + ${w.deal}     * b.deal
        + ${w.velocity} * b.velocity
        + ${w.clicks}   * b.clicks
        + ${w.shop}     * b.shop
      ) * b.penalty * 1000) / 1000,
      last_scored_at = NOW()
    FROM base b
    WHERE p.id = b.id
    RETURNING p.id
  `);
  log.info({ scored: res.length }, "products rescored");
  return { scored: res.length };
}
