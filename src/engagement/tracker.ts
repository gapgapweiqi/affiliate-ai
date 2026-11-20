/**
 * M7 Engagement Tracker — Sprint 15.
 *
 * For every published_post that's still within its measurement window,
 * pull engagement metrics from the platform's analytics API and write
 * a snapshot into post_metrics. Time-series rows let us chart growth and
 * feed reach/impressions back into the bandit (M3 picks variants by
 * conversion, but we should also reward variants that just get more
 * eyeballs — impressions and reactions are leading indicators).
 *
 * Per-platform endpoints (Meta Graph v21.0):
 *   FB Page post:     GET /{post-id}/insights
 *                       ?metric=post_impressions,post_clicks,post_reactions_by_type_total
 *   IG Business media: GET /{ig-media-id}/insights
 *                       ?metric=impressions,reach,likes,comments,shares,saved
 *   TikTok video:     /v2/research/video/query/  (Research API — gated)
 *                     For Content Posting API videos we don't have
 *                     analytics; rely on our own /go click tracking.
 *
 * DRY-RUN strategy: when the platform token is missing, we skip the
 * fetch entirely (no-op, no synthetic numbers). The post_metrics table
 * stays empty until tokens arrive — exactly the right behavior for
 * "ถ้าเรื่องคีย์ค่อยทำทีหลังสุดได้ไหม" (defer keys to end).
 */

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { errMsg, retry } from "../lib/retry.ts";
import { resolvePageToken } from "../publisher/facebook.ts";

const log = child("engagement.tracker");
const GRAPH_BASE = "https://graph.facebook.com/v21.0";

/** Posts older than this aren't worth re-polling — engagement plateaus. */
const TRACKING_WINDOW_DAYS = 7;

export interface EngagementMetrics {
  impressions: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  watchTimeSec: number | null;
  raw: Record<string, unknown>;
}

export interface TrackerResult {
  postsScanned: number;
  postsFetched: number;
  postsSkipped: number;
  postsFailed: number;
  byChannel: Record<string, number>;
}

const EMPTY: EngagementMetrics = {
  impressions: null, reach: null, views: null, likes: null,
  comments: null, shares: null, saves: null, clicks: null,
  watchTimeSec: null, raw: {},
};

/* -----------------------------------------------------------------------------
 * Per-platform fetchers — return null if platform isn't configured (dry-run).
 * ---------------------------------------------------------------------------*/

/**
 * Facebook Page post metrics. Works with a Page token or an admin's user
 * token (exchanged for the Page token), for photo/text posts (id
 * "<page>_<post>") and video/Reel posts (we store the video id, so look up
 * its post id first).
 *
 * Insights metrics need the token's `read_insights` permission; without it
 * Meta returns empty data and only reactions/comments/shares are filled.
 * Meta keeps renaming/retiring Page Insights metrics, so each metric is
 * requested on its own and missing ones are skipped instead of failing
 * the whole fetch. Reactions/comments/shares come from the post object,
 * which is stable. `clicks` = link clicks when Meta reports them, else all
 * post clicks — this is the click count used once posts link straight to
 * Shopee (no /go/ redirect of our own).
 */
async function fetchFacebookMetrics(platformPostId: string): Promise<EngagementMetrics | null> {
  if (!env.META_PAGE_ACCESS_TOKEN || !env.META_PAGE_ID) return null;
  const token = await resolvePageToken(env.META_PAGE_ID, env.META_PAGE_ACCESS_TOKEN);
  const q = (path: string) => `${GRAPH_BASE}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const getJson = async (path: string) => {
    const res = await fetch(q(path));
    const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok || body.error) throw new Error(body.error?.message ?? `fb ${res.status}`);
    return body;
  };

  // Video/Reel uploads return a bare video id; its post is "<page>_<video>".
  const postId = platformPostId.includes("_") ? platformPostId : `${env.META_PAGE_ID}_${platformPostId}`;

  const metric = async (name: string): Promise<unknown> => {
    try {
      const body = (await getJson(`${postId}/insights?metric=${name}`)) as { data?: Array<{ values?: Array<{ value: unknown }> }> };
      return body.data?.[0]?.values?.[0]?.value ?? null;
    } catch {
      return null; // metric retired / not available for this post type
    }
  };

  const [obj, clicksByType, clicksAll, views, reachA, reachB] = await Promise.all([
    retry(() => getJson(`${postId}?fields=shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)`), {
      attempts: 2,
      baseDelayMs: 500,
    }),
    metric("post_clicks_by_type"),
    metric("post_clicks"),
    metric("post_media_view"),
    metric("post_impressions_unique"),
    metric("post_total_media_view_unique"),
  ]);
  const o = obj as {
    shares?: { count?: number };
    comments?: { summary?: { total_count?: number } };
    reactions?: { summary?: { total_count?: number } };
  };
  const linkClicks = clicksByType && typeof clicksByType === "object"
    ? numOrNull((clicksByType as Record<string, unknown>)["link clicks"])
    : null;

  return {
    ...EMPTY,
    views: numOrNull(views),
    impressions: numOrNull(views),
    reach: numOrNull(reachA) ?? numOrNull(reachB),
    likes: o.reactions?.summary?.total_count ?? null,
    comments: o.comments?.summary?.total_count ?? null,
    shares: o.shares?.count ?? 0,
    clicks: linkClicks ?? numOrNull(clicksAll),
    raw: { postId, object: obj, clicksByType, clicksAll, views, reach: reachA ?? reachB },
  };
}

async function fetchInstagramMetrics(platformPostId: string): Promise<EngagementMetrics | null> {
  if (!env.META_PAGE_ACCESS_TOKEN) return null;

  // IG metrics endpoint — note: "saved" not "saves", "video_views" for reels
  const url = `${GRAPH_BASE}/${platformPostId}/insights` +
    `?metric=impressions,reach,likes,comments,shares,saved` +
    `&access_token=${env.META_PAGE_ACCESS_TOKEN}`;

  const json = await retry(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ig insights ${res.status}: ${await res.text()}`);
    return res.json() as Promise<{ data?: Array<{ name: string; values: Array<{ value: number }> }> }>;
  }, { attempts: 3, baseDelayMs: 500 });

  const data = json.data ?? [];
  const get = (n: string): number | null => {
    const m = data.find((d) => d.name === n);
    return m?.values?.[0]?.value ?? null;
  };

  return {
    ...EMPTY,
    impressions: get("impressions"),
    reach: get("reach"),
    likes: get("likes"),
    comments: get("comments"),
    shares: get("shares"),
    saves: get("saved"),
    raw: json as Record<string, unknown>,
  };
}

async function fetchTikTokMetrics(_platformPostId: string): Promise<EngagementMetrics | null> {
  // The Content Posting API doesn't expose post-level analytics for the
  // poster. Research API would, but it's gated. Until we get research
  // access, TikTok engagement comes from our own /go click counts only.
  if (!env.TIKTOK_ACCESS_TOKEN) return null;
  return null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/* -----------------------------------------------------------------------------
 * Main loop
 * ---------------------------------------------------------------------------*/

export async function runEngagementTracker(): Promise<TrackerResult> {
  const since = new Date(Date.now() - TRACKING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select({
      id: schema.publishedPosts.id,
      channel: schema.publishedPosts.channel,
      platformPostId: schema.publishedPosts.platformPostId,
      dryRun: schema.publishedPosts.dryRun,
    })
    .from(schema.publishedPosts)
    .where(
      and(
        eq(schema.publishedPosts.status, "published"),
        eq(schema.publishedPosts.dryRun, false),
        isNotNull(schema.publishedPosts.platformPostId),
        gte(schema.publishedPosts.publishedAt, since),
      ),
    )
    .orderBy(sql`${schema.publishedPosts.publishedAt} DESC`)
    .limit(200);

  log.info({ candidates: candidates.length, sinceDays: TRACKING_WINDOW_DAYS }, "engagement tracker start");

  const result: TrackerResult = {
    postsScanned: candidates.length,
    postsFetched: 0,
    postsSkipped: 0,
    postsFailed: 0,
    byChannel: {},
  };

  for (const post of candidates) {
    if (!post.platformPostId) {
      result.postsSkipped++;
      continue;
    }

    let metrics: EngagementMetrics | null;
    try {
      switch (post.channel) {
        case "facebook":
          metrics = await fetchFacebookMetrics(post.platformPostId);
          break;
        case "instagram":
          metrics = await fetchInstagramMetrics(post.platformPostId);
          break;
        case "tiktok":
          metrics = await fetchTikTokMetrics(post.platformPostId);
          break;
        default:
          metrics = null;
      }
    } catch (err) {
      log.warn(
        { postId: post.id, channel: post.channel, err: errMsg(err) },
        "metrics fetch failed",
      );
      result.postsFailed++;
      continue;
    }

    if (metrics === null) {
      result.postsSkipped++;
      continue;
    }

    await db.insert(schema.postMetrics).values({
      publishedPostId: post.id,
      impressions: metrics.impressions,
      reach: metrics.reach,
      views: metrics.views,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      saves: metrics.saves,
      clicks: metrics.clicks,
      watchTimeSec: metrics.watchTimeSec,
      raw: metrics.raw,
    });
    result.postsFetched++;
    result.byChannel[post.channel] = (result.byChannel[post.channel] ?? 0) + 1;
  }

  log.info(result, "engagement tracker done");
  return result;
}
