import "server-only";
import { sql } from "drizzle-orm";
import { one, rows } from "./db";

// All day bucketing uses Bangkok time — the operator's day.
const BKK_DAY = sql.raw(`(now() AT TIME ZONE 'Asia/Bangkok')::date`);

/* ───────────────────────── Daily Snapshot ───────────────────────── */

export interface SnapshotKpis {
  clicksToday: number;
  clicksYesterday: number;
  newProductsToday: number;
  newProductsYesterday: number;
  postsToday: number;
  postsYesterday: number;
  llmMicrosToday: number;
  scrapeMicrosToday: number;
  activeProducts: number;
  openAlerts: number;
  revenueSatang30d: number;
}

export function getSnapshotKpis() {
  return one<SnapshotKpis>(sql`
    SELECT
      (SELECT count(*) FROM clicks WHERE NOT is_bot AND (clicked_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY})::int AS "clicksToday",
      (SELECT count(*) FROM clicks WHERE NOT is_bot AND (clicked_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY} - 1)::int AS "clicksYesterday",
      (SELECT count(*) FROM products WHERE (first_seen_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY})::int AS "newProductsToday",
      (SELECT count(*) FROM products WHERE (first_seen_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY} - 1)::int AS "newProductsYesterday",
      (SELECT count(*) FROM published_posts WHERE status = 'published' AND NOT dry_run AND (published_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY})::int AS "postsToday",
      (SELECT count(*) FROM published_posts WHERE status = 'published' AND NOT dry_run AND (published_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY} - 1)::int AS "postsYesterday",
      (SELECT coalesce(sum(cost_usd_micros), 0) FROM generation_runs WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY})::bigint AS "llmMicrosToday",
      (SELECT coalesce(sum(cost_usd_micros), 0) FROM scraper_runs WHERE (started_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY})::bigint AS "scrapeMicrosToday",
      (SELECT count(*) FROM products WHERE is_active AND NOT flag_blacklisted)::int AS "activeProducts",
      (SELECT count(*) FROM alerts WHERE resolved_at IS NULL)::int AS "openAlerts",
      (SELECT coalesce(sum(revenue_satang), 0) FROM insights WHERE snapshot_date >= to_char(${BKK_DAY} - 30, 'YYYY-MM-DD') AND scope = 'channel')::bigint AS "revenueSatang30d"
  `);
}

export interface DailyPoint {
  day: string;
  clicks: number;
  posts: number;
  newProducts: number;
}

/** Last N days (Bangkok), zero-filled. */
export function getDailySeries(days = 14) {
  return rows<DailyPoint>(sql`
    WITH d AS (
      SELECT generate_series(${BKK_DAY} - ${days - 1}::int, ${BKK_DAY}, '1 day')::date AS day
    )
    SELECT
      to_char(d.day, 'MM-DD') AS day,
      (SELECT count(*) FROM clicks c WHERE NOT c.is_bot AND (c.clicked_at AT TIME ZONE 'Asia/Bangkok')::date = d.day)::int AS clicks,
      (SELECT count(*) FROM published_posts p WHERE p.status = 'published' AND NOT p.dry_run AND (p.published_at AT TIME ZONE 'Asia/Bangkok')::date = d.day)::int AS posts,
      (SELECT count(*) FROM products pr WHERE (pr.first_seen_at AT TIME ZONE 'Asia/Bangkok')::date = d.day)::int AS "newProducts"
    FROM d ORDER BY d.day
  `);
}

/* ───────────────────────── Revenue ───────────────────────── */

export interface ChannelRow {
  channel: string;
  links: number;
  clicks: number;
  uniqueClicks: number;
  revenueSatang: number;
  conversions: number;
}

export function getChannelPerformance(days = 30) {
  return rows<ChannelRow>(sql`
    SELECT
      l.channel::text AS channel,
      count(DISTINCT l.id)::int AS links,
      count(c.id) FILTER (WHERE NOT c.is_bot)::int AS clicks,
      count(c.id) FILTER (WHERE NOT c.is_bot AND c.is_unique)::int AS "uniqueClicks",
      coalesce((SELECT sum(v.revenue_satang) FROM content_variants v WHERE v.channel = l.channel), 0)::bigint AS "revenueSatang",
      coalesce((SELECT sum(v.times_converted) FROM content_variants v WHERE v.channel = l.channel), 0)::int AS conversions
    FROM affiliate_links l
    LEFT JOIN clicks c ON c.affiliate_link_id = l.id AND c.clicked_at > now() - make_interval(days => ${days})
    GROUP BY l.channel
    ORDER BY clicks DESC
  `);
}

export interface TopProductRow {
  id: number;
  name: string;
  niche: string | null;
  currentPrice: number;
  clicks: number;
  revenueSatang: number;
}

export function getTopProductsByClicks(days = 30, limit = 15) {
  return rows<TopProductRow>(sql`
    SELECT p.id, p.name, p.niche::text AS niche, p.current_price AS "currentPrice",
      count(c.id)::int AS clicks,
      coalesce((SELECT sum(v.revenue_satang) FROM content_variants v WHERE v.product_id = p.id), 0)::bigint AS "revenueSatang"
    FROM clicks c
    JOIN affiliate_links l ON l.id = c.affiliate_link_id
    JOIN products p ON p.id = l.product_id
    WHERE NOT c.is_bot AND c.clicked_at > now() - make_interval(days => ${days})
    GROUP BY p.id
    ORDER BY clicks DESC
    LIMIT ${limit}
  `);
}

/* ───────────────────────── Content ───────────────────────── */

export interface AngleRow {
  channel: string;
  angle: string;
  total: number;
  approved: number;
  shown: number;
  clicked: number;
}

export function getVariantStatsByAngle() {
  return rows<AngleRow>(sql`
    SELECT channel::text AS channel, angle::text AS angle,
      count(*)::int AS total,
      count(*) FILTER (WHERE gate_approved)::int AS approved,
      coalesce(sum(times_shown), 0)::int AS shown,
      coalesce(sum(times_clicked), 0)::int AS clicked
    FROM content_variants
    GROUP BY channel, angle
    ORDER BY channel, total DESC
  `);
}

export interface PostRow {
  id: number;
  channel: string;
  status: string;
  dryRun: boolean;
  caption: string | null;
  imageUrl: string | null;
  url: string | null;
  productName: string | null;
  failureReason: string | null;
  createdAt: string;
  impressions: number | null;
  clicks: number | null;
}

export function getRecentPosts(limit = 30) {
  return rows<PostRow>(sql`
    SELECT pp.id, pp.channel::text AS channel, pp.status::text AS status, pp.dry_run AS "dryRun",
      pp.caption_posted AS caption, pp.image_url AS "imageUrl", pp.platform_post_url AS url,
      p.name AS "productName", pp.failure_reason AS "failureReason", pp.created_at AS "createdAt",
      m.impressions, m.clicks
    FROM published_posts pp
    LEFT JOIN products p ON p.id = pp.product_id
    LEFT JOIN LATERAL (
      SELECT impressions, clicks FROM post_metrics pm WHERE pm.published_post_id = pp.id
      ORDER BY captured_at DESC LIMIT 1
    ) m ON true
    ORDER BY pp.id DESC
    LIMIT ${limit}
  `);
}

export interface PostStatusRow {
  channel: string;
  status: string;
  dryRun: boolean;
  n: number;
}

export function getPostStatusCounts() {
  return rows<PostStatusRow>(sql`
    SELECT channel::text AS channel, status::text AS status, dry_run AS "dryRun", count(*)::int AS n
    FROM published_posts GROUP BY 1, 2, 3 ORDER BY 1, 2
  `);
}

/* ───────────────────────── Trends ───────────────────────── */

export interface PromoRow {
  id: number;
  productId: number;
  productName: string;
  eventType: string;
  deltaPct: number | null;
  prevValue: number | null;
  currValue: number | null;
  detectedAt: string;
}

export function getRecentPromoEvents(limit = 25) {
  return rows<PromoRow>(sql`
    SELECT e.id, e.product_id AS "productId", p.name AS "productName", e.event_type::text AS "eventType",
      e.delta_pct AS "deltaPct", e.prev_value AS "prevValue", e.curr_value AS "currValue", e.detected_at AS "detectedAt"
    FROM promo_events e JOIN products p ON p.id = e.product_id
    ORDER BY e.detected_at DESC LIMIT ${limit}
  `);
}

export interface NicheRow {
  niche: string;
  products: number;
  avgDiscount: number | null;
  avgRating: number | null;
  clicks30d: number;
}

export function getNicheBreakdown() {
  return rows<NicheRow>(sql`
    SELECT coalesce(p.niche::text, 'unassigned') AS niche,
      count(DISTINCT p.id)::int AS products,
      avg(p.discount_percent)::float AS "avgDiscount",
      avg(p.rating)::float AS "avgRating",
      count(c.id) FILTER (WHERE NOT c.is_bot AND c.clicked_at > now() - interval '30 days')::int AS "clicks30d"
    FROM products p
    LEFT JOIN affiliate_links l ON l.product_id = p.id
    LEFT JOIN clicks c ON c.affiliate_link_id = l.id
    WHERE p.is_active
    GROUP BY 1 ORDER BY products DESC
  `);
}

export interface OpportunityRow {
  id: number;
  name: string;
  niche: string | null;
  currentPrice: number;
  originalPrice: number | null;
  discountPercent: number | null;
  rating: number | null;
  ratingCount: number | null;
  finalScore: number | null;
  firstSeenAt: string;
}

/** Fresh, well-rated, discounted products that have no approved social variant yet. */
export function getOpportunities(limit = 20) {
  return rows<OpportunityRow>(sql`
    SELECT p.id, p.name, p.niche::text AS niche, p.current_price AS "currentPrice",
      p.original_price AS "originalPrice", p.discount_percent AS "discountPercent",
      p.rating, p.rating_count AS "ratingCount", p.final_score AS "finalScore", p.first_seen_at AS "firstSeenAt"
    FROM products p
    WHERE p.is_active AND NOT p.flag_blacklisted
      AND p.current_price > 5000 AND coalesce(p.discount_percent, 0) BETWEEN 0.2 AND 0.9
      AND coalesce(p.rating, 0) >= 4.5
      AND NOT EXISTS (SELECT 1 FROM content_variants v WHERE v.product_id = p.id AND v.gate_approved)
    ORDER BY coalesce(p.final_score, 0) DESC, p.discount_percent DESC NULLS LAST, p.rating_count DESC NULLS LAST
    LIMIT ${limit}
  `);
}

/* ───────────────────────── System Health ───────────────────────── */

export interface ScraperRunRow {
  id: number;
  scraper: string;
  target: string | null;
  status: string;
  attempted: number | null;
  succeeded: number | null;
  costMicros: number | null;
  durationMs: number | null;
  errorMsg: string | null;
  startedAt: string;
}

export function getScraperRuns(limit = 20) {
  return rows<ScraperRunRow>(sql`
    SELECT id, scraper, target, status::text AS status, items_attempted AS attempted,
      items_succeeded AS succeeded, cost_usd_micros AS "costMicros", duration_ms AS "durationMs",
      error_msg AS "errorMsg", started_at AS "startedAt"
    FROM scraper_runs ORDER BY started_at DESC LIMIT ${limit}
  `);
}

export interface SpendRow {
  day: string;
  llm: number;
  scrape: number;
}

export function getSpendSeries(days = 14) {
  return rows<SpendRow>(sql`
    WITH d AS (SELECT generate_series(${BKK_DAY} - ${days - 1}::int, ${BKK_DAY}, '1 day')::date AS day)
    SELECT to_char(d.day, 'MM-DD') AS day,
      coalesce((SELECT sum(cost_usd_micros) FROM generation_runs g WHERE (g.created_at AT TIME ZONE 'Asia/Bangkok')::date = d.day), 0)::float / 1e6 AS llm,
      coalesce((SELECT sum(cost_usd_micros) FROM scraper_runs s WHERE (s.started_at AT TIME ZONE 'Asia/Bangkok')::date = d.day), 0)::float / 1e6 AS scrape
    FROM d ORDER BY d.day
  `);
}

export interface TaskSpendRow {
  task: string;
  model: string;
  calls: number;
  failures: number;
  costMicros: number;
  avgMs: number;
}

export function getLlmSpendByTask(days = 7) {
  return rows<TaskSpendRow>(sql`
    SELECT task, model, count(*)::int AS calls, count(*) FILTER (WHERE NOT success)::int AS failures,
      coalesce(sum(cost_usd_micros), 0)::bigint AS "costMicros", coalesce(avg(duration_ms), 0)::int AS "avgMs"
    FROM generation_runs WHERE created_at > now() - make_interval(days => ${days})
    GROUP BY task, model ORDER BY "costMicros" DESC
  `);
}

export interface TableCountRow {
  name: string;
  n: number;
}

export function getTableCounts() {
  return rows<TableCountRow>(sql`
    SELECT 'products' AS name, count(*)::int AS n FROM products
    UNION ALL SELECT 'affiliate_links', count(*)::int FROM affiliate_links
    UNION ALL SELECT 'clicks', count(*)::int FROM clicks
    UNION ALL SELECT 'content_variants', count(*)::int FROM content_variants
    UNION ALL SELECT 'published_posts', count(*)::int FROM published_posts
    UNION ALL SELECT 'product_prices', count(*)::int FROM product_prices
    UNION ALL SELECT 'generation_runs', count(*)::int FROM generation_runs
  `);
}

export function getLastScrape() {
  return one<{ lastScrapedAt: string | null }>(sql`
    SELECT max(last_scraped_at) AS "lastScrapedAt" FROM products WHERE is_active
  `);
}

/* ───────────────────────── Compliance & Risk ───────────────────────── */

export interface RejectedVariantRow {
  id: number;
  productName: string;
  channel: string;
  angle: string;
  caption: string;
  issues: string[] | null;
  createdAt: string;
}

export function getRejectedVariants(limit = 25) {
  return rows<RejectedVariantRow>(sql`
    SELECT v.id, p.name AS "productName", v.channel::text AS channel, v.angle::text AS angle,
      v.caption, v.gate_issues AS issues, v.created_at AS "createdAt"
    FROM content_variants v JOIN products p ON p.id = v.product_id
    WHERE NOT v.gate_approved
    ORDER BY v.id DESC LIMIT ${limit}
  `);
}

export interface IssueCountRow {
  kind: string;
  n: number;
}

/** Group gate issues by their leading tag, e.g. "[moderator] AGGRESSIVE". */
export function getIssueBreakdown() {
  return rows<IssueCountRow>(sql`
    SELECT coalesce(substring(issue FROM '^(\\[[^\\]]+\\]\\s*[A-Z_]+)'), left(issue, 40)) AS kind, count(*)::int AS n
    FROM content_variants v, jsonb_array_elements_text(coalesce(v.gate_issues, '[]'::jsonb)) AS issue
    WHERE NOT v.gate_approved
    GROUP BY 1 ORDER BY n DESC LIMIT 12
  `);
}

export interface FlaggedProductRow {
  id: number;
  name: string;
  blacklisted: boolean;
  regulated: boolean;
  reason: string | null;
}

export function getFlaggedProducts() {
  return rows<FlaggedProductRow>(sql`
    SELECT id, name, flag_blacklisted AS blacklisted, flag_regulated AS regulated, flag_reason AS reason
    FROM products WHERE flag_blacklisted OR flag_regulated ORDER BY id DESC LIMIT 50
  `);
}

export interface SuspiciousPriceRow {
  id: number;
  name: string;
  currentPrice: number;
  originalPrice: number | null;
  discountPercent: number | null;
}

/** Decoy listings (e.g. ฿1 with 99% off) that shouldn't be promoted. */
export function getSuspiciousPrices() {
  return rows<SuspiciousPriceRow>(sql`
    SELECT id, name, current_price AS "currentPrice", original_price AS "originalPrice", discount_percent AS "discountPercent"
    FROM products
    WHERE is_active AND NOT flag_blacklisted AND (current_price < 2000 OR discount_percent >= 0.9)
    ORDER BY current_price ASC LIMIT 30
  `);
}

/* ───────────────────────── Action Center ───────────────────────── */

export interface AlertRow {
  id: number;
  severity: string;
  code: string;
  title: string;
  body: string | null;
  requiresUserAction: boolean;
  createdAt: string;
}

export function getOpenAlerts() {
  return rows<AlertRow>(sql`
    SELECT id, severity::text AS severity, code, title, body, requires_user_action AS "requiresUserAction", created_at AS "createdAt"
    FROM alerts WHERE resolved_at IS NULL
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END, created_at DESC
  `);
}

export interface FailedPostRow {
  id: number;
  channel: string;
  productName: string | null;
  failureReason: string | null;
  createdAt: string;
}

export function getFailedPosts(limit = 15) {
  return rows<FailedPostRow>(sql`
    SELECT pp.id, pp.channel::text AS channel, p.name AS "productName", pp.failure_reason AS "failureReason", pp.created_at AS "createdAt"
    FROM published_posts pp LEFT JOIN products p ON p.id = pp.product_id
    WHERE pp.status IN ('failed', 'rate_limited') AND pp.created_at > now() - interval '7 days'
    ORDER BY pp.id DESC LIMIT ${limit}
  `);
}

/* ───────────────────────── Post Queue ─────────────────────────
 * Mirrors the bot's own selection so the operator sees what goes out next:
 *   photo posts → src/publisher/auto-publish.ts (per channel)
 *   video post  → src/publisher/auto-video.ts
 * Keep the WHERE / ORDER BY clauses in sync with those files.
 */

export interface QueueItem {
  id: number;
  name: string;
  image: string | null;
  currentPrice: number | null;
  originalPrice: number | null;
  discountPercent: number | null;
  rating: number | null;
  soldCount: number | null;
  finalScore: number | null;
  demandScore: number | null;
  dealScore: number | null;
  trendVelocity: number | null;
  isPromo: boolean;
  approvedVariants: number;
  lastPostedAt: string | null;
}

const QUEUE_COLUMNS = sql.raw(`
  p.id, p.name, p.primary_image AS image,
  p.current_price AS "currentPrice", p.original_price AS "originalPrice",
  p.discount_percent AS "discountPercent", p.rating, p.sold_count AS "soldCount",
  p.final_score AS "finalScore", p.demand_score AS "demandScore",
  p.profitability_score AS "dealScore", p.trend_velocity AS "trendVelocity"`);

/** Photo-post queue for one channel, in the exact order auto-publish picks. */
export function getPostQueue(channel: "facebook" | "instagram" | "tiktok", limit = 10) {
  return rows<QueueItem>(sql`
    SELECT ${QUEUE_COLUMNS},
      EXISTS(SELECT 1 FROM promo_events pe
             WHERE pe.product_id = p.id AND pe.detected_at > now() - interval '6 hours') AS "isPromo",
      (SELECT count(*) FROM content_variants cv
        WHERE cv.product_id = p.id AND cv.channel = ${channel} AND cv.gate_approved AND cv.is_active)::int AS "approvedVariants",
      (SELECT max(published_at) FROM published_posts pp
        WHERE pp.product_id = p.id AND pp.channel = ${channel} AND pp.status = 'published') AS "lastPostedAt"
    FROM products p
    WHERE p.is_active AND NOT p.flag_blacklisted
      AND EXISTS (SELECT 1 FROM content_variants cv
                  WHERE cv.product_id = p.id AND cv.channel = ${channel} AND cv.gate_approved AND cv.is_active)
      AND NOT EXISTS (SELECT 1 FROM published_posts pp
                      WHERE pp.product_id = p.id AND pp.channel = ${channel} AND pp.status = 'published'
                        AND pp.published_at > now() - interval '24 hours')
    ORDER BY "isPromo" DESC, coalesce(p.final_score, 0) DESC, p.first_seen_at DESC
    LIMIT ${limit}
  `);
}

/** Products held back by the 24 h repeat rule (have a caption, posted recently). */
export function getCoolingDown(channel: "facebook" | "instagram" | "tiktok") {
  return rows<{ id: number; name: string; finalScore: number | null; lastPostedAt: string }>(sql`
    SELECT p.id, p.name, p.final_score AS "finalScore", max(pp.published_at) AS "lastPostedAt"
    FROM products p JOIN published_posts pp ON pp.product_id = p.id
    WHERE pp.channel = ${channel} AND pp.status = 'published' AND pp.published_at > now() - interval '24 hours'
    GROUP BY p.id, p.name, p.final_score
    ORDER BY max(pp.published_at) DESC
  `);
}

/** Live (non-dry-run) posts today per channel, Bangkok day — the daily cap counts these. */
export function getPostsTodayByChannel() {
  return rows<{ channel: string; live: number; dryRun: number }>(sql`
    SELECT channel::text,
      count(*) FILTER (WHERE NOT dry_run)::int AS live,
      count(*) FILTER (WHERE dry_run)::int AS "dryRun"
    FROM published_posts
    WHERE status = 'published' AND (published_at AT TIME ZONE 'Asia/Bangkok')::date = ${BKK_DAY}
    GROUP BY channel
  `);
}

/** Video-post queue, in the exact order auto-video picks (7-day per-product cooldown). */
export function getVideoQueue(limit = 5) {
  return rows<QueueItem>(sql`
    SELECT ${QUEUE_COLUMNS}, false AS "isPromo",
      (SELECT count(*) FROM content_variants cv
        WHERE cv.product_id = p.id AND cv.channel = 'facebook' AND cv.gate_approved AND cv.is_active)::int AS "approvedVariants",
      (SELECT max(created_at) FROM published_posts pp
        WHERE pp.product_id = p.id AND pp.channel = 'facebook' AND pp.video_url IS NOT NULL) AS "lastPostedAt"
    FROM products p
    WHERE p.is_active AND NOT p.flag_blacklisted
      AND p.primary_image LIKE 'https://%'
      AND coalesce(p.final_score, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM published_posts pp
                      WHERE pp.product_id = p.id AND pp.channel = 'facebook' AND pp.video_url IS NOT NULL
                        AND pp.created_at > now() - interval '7 days')
    ORDER BY p.final_score DESC, p.first_seen_at DESC
    LIMIT ${limit}
  `);
}
