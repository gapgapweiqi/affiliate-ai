/**
 * TikTok publisher — Content Posting API, Direct Post.
 *
 *   1. POST /v2/post/publish/creator_info/query/  → allowed privacy levels
 *   2. POST /v2/post/publish/video/init/
 *        source FILE_UPLOAD  (local MP4: no domain to verify — default)
 *        source PULL_FROM_URL (public URL; TikTok requires the URL's domain
 *                              to be verified in the developer portal)
 *   3. PUT the file to upload_url (one chunk — our clips are well under 64 MB)
 *   4. POST /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE / FAILED
 *
 * Until the app passes TikTok's audit, Direct Post only allows SELF_ONLY
 * (private) — creator_info says so, and we fall back to it automatically.
 *
 * Credentials: getTikTokCredentials() (oauth_tokens table, auto-refreshed;
 * set up once with src/scripts/tiktok-auth.ts).
 *
 * DRY-RUN: when credentials are missing or DEBUG_DRY_RUN=true, simulates the
 * flow and writes a dry_run row.
 *
 * Docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { errMsg, retry, sleep } from "../lib/retry.ts";
import { getTikTokCredentials, type TikTokCredentials } from "./tiktok-auth.ts";
import { loadVariant, pickVariant } from "./variant-picker.ts";

const log = child("publisher.tiktok");
const TIKTOK_BASE = "https://open.tiktokapis.com";
const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;

type Privacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

export interface PublishToTikTokOptions {
  productId: number;
  /** Local MP4 to upload directly (preferred — no domain verification needed). */
  videoPath?: string;
  /** Public MP4 URL (PULL_FROM_URL — its domain must be verified with TikTok). */
  videoUrl?: string;
  /** Post this exact caption variant instead of letting the picker choose. */
  variantId?: number;
  /** Wanted privacy (default PUBLIC). Falls back to SELF_ONLY when not allowed (unaudited app). */
  privacyLevel?: Privacy;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  forceDryRun?: boolean;
}

export interface PublishResult {
  publishedPostId: number;
  platformPostId: string | null;
  platformPostUrl: string | null;
  status: "published" | "failed" | "rate_limited" | "queued";
  variantId: number | null;
  dryRun: boolean;
  /** Privacy actually used (SELF_ONLY until the app is audited). */
  privacy?: Privacy;
  errorMsg?: string;
}

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code: string; message: string; log_id?: string };
}

async function api<T>(creds: TikTokCredentials, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${TIKTOK_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as TikTokEnvelope<T>;
  if (json.error && json.error.code !== "ok") {
    throw new Error(`TikTok ${path} ${json.error.code}: ${json.error.message}`);
  }
  if (!res.ok || !json.data) throw new Error(`TikTok ${path} HTTP ${res.status}`);
  return json.data;
}

export async function publishToTikTok(opts: PublishToTikTokOptions): Promise<PublishResult> {
  const creds = opts.forceDryRun || env.DEBUG_DRY_RUN ? null : await getTikTokCredentials();
  const dryRun = Boolean(opts.forceDryRun || env.DEBUG_DRY_RUN || !creds);

  const variant = opts.variantId ? await loadVariant(opts.variantId, "tiktok") : await pickVariant(opts.productId, "tiktok");
  const fail = async (reason: string, variantId: number | null): Promise<PublishResult> => {
    const [row] = await db
      .insert(schema.publishedPosts)
      .values({
        contentVariantId: variantId,
        productId: opts.productId,
        channel: "tiktok",
        status: "failed",
        captionPosted: variant?.caption ?? null,
        failureReason: reason,
        failedAt: new Date(),
        dryRun,
      })
      .returning({ id: schema.publishedPosts.id });
    log.warn({ productId: opts.productId, reason }, "tiktok publish skipped");
    return { publishedPostId: row!.id, platformPostId: null, platformPostUrl: null, status: "failed", variantId, dryRun, errorMsg: reason };
  };

  if (!variant) return fail("no approved tiktok variant", null);
  if (!opts.videoPath && !opts.videoUrl) return fail("TikTok needs a video (videoPath or videoUrl)", variant.id);

  const caption = variant.hashtags.length && !variant.caption.includes("#")
    ? `${variant.caption}\n\n${variant.hashtags.join(" ")}`
    : variant.caption;

  const [postRow] = await db
    .insert(schema.publishedPosts)
    .values({
      contentVariantId: variant.id,
      productId: opts.productId,
      channel: "tiktok",
      status: "publishing",
      captionPosted: caption,
      videoUrl: opts.videoUrl ?? (opts.videoPath ? `file:${basename(opts.videoPath)}` : null),
      dryRun,
    })
    .returning({ id: schema.publishedPosts.id });
  const publishedPostId = postRow!.id;

  let platformPostId: string | null = null;
  let platformPostUrl: string | null = null;
  let status: PublishResult["status"] = "published";
  let errorMsg: string | undefined;
  let privacy: Privacy | undefined;

  if (dryRun) {
    platformPostId = `fake_tt_${crypto.randomUUID().slice(0, 18)}`;
    platformPostUrl = null;
    log.info(
      { publishedPostId, productId: opts.productId, variantId: variant.id, captionLen: caption.length, hasVideo: true },
      "[DRY-RUN] would publish to TikTok",
    );
  } else {
    try {
      const r = await directPost(creds!, caption, opts);
      platformPostId = r.platformPostId;
      platformPostUrl = r.platformPostUrl;
      privacy = r.privacy;
    } catch (err) {
      const msg = errMsg(err);
      status = /rate|throttl|spam_risk_too_many/i.test(msg) ? "rate_limited" : "failed";
      errorMsg = msg;
      log.error({ publishedPostId, err: msg }, "tiktok publish failed");
    }
  }

  await db
    .update(schema.publishedPosts)
    .set({
      status,
      platformPostId,
      platformPostUrl,
      publishedAt: status === "published" ? new Date() : null,
      failedAt: status === "failed" ? new Date() : null,
      failureReason: errorMsg ?? null,
    })
    .where(eq(schema.publishedPosts.id, publishedPostId));

  return { publishedPostId, platformPostId, platformPostUrl, status, variantId: variant.id, dryRun, privacy, errorMsg };
}

async function directPost(
  creds: TikTokCredentials,
  caption: string,
  opts: PublishToTikTokOptions,
): Promise<{ platformPostId: string; platformPostUrl: string | null; privacy: Privacy }> {
  // 1. What may this account post? (unaudited apps: SELF_ONLY only)
  const info = await api<{ privacy_level_options?: Privacy[]; creator_username?: string; max_video_post_duration_sec?: number }>(
    creds,
    "/v2/post/publish/creator_info/query/",
    {},
  );
  const allowed = info.privacy_level_options ?? ["SELF_ONLY"];
  const wanted = opts.privacyLevel ?? "PUBLIC_TO_EVERYONE";
  const privacy: Privacy = allowed.includes(wanted) ? wanted : allowed.includes("SELF_ONLY") ? "SELF_ONLY" : allowed[0]!;
  if (privacy !== wanted) {
    log.warn({ wanted, allowed, using: privacy }, "TikTok privacy not allowed for this app yet (audit pending?) — posting as " + privacy);
  }

  const post_info = {
    title: caption.slice(0, 2200),
    privacy_level: privacy,
    disable_comment: opts.disableComment ?? false,
    disable_duet: opts.disableDuet ?? false,
    disable_stitch: opts.disableStitch ?? false,
  };

  // 2. Init (+ 3. upload)
  let publishId: string;
  if (opts.videoPath) {
    const size = (await stat(opts.videoPath)).size;
    if (size > MAX_SINGLE_CHUNK) throw new Error(`video is ${size} bytes; single-chunk upload supports up to 64 MB`);
    const init = await retry(
      () =>
        api<{ publish_id: string; upload_url: string }>(creds, "/v2/post/publish/video/init/", {
          post_info,
          source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
        }),
      { attempts: 2, baseDelayMs: 1000 },
    );
    publishId = init.publish_id;
    const bytes = await readFile(opts.videoPath);
    const put = await fetch(init.upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(size),
        "Content-Range": `bytes 0-${size - 1}/${size}`,
      },
      body: bytes,
    });
    if (!put.ok) throw new Error(`TikTok upload HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
  } else {
    const init = await retry(
      () =>
        api<{ publish_id: string }>(creds, "/v2/post/publish/video/init/", {
          post_info,
          source_info: { source: "PULL_FROM_URL", video_url: opts.videoUrl },
        }),
      { attempts: 2, baseDelayMs: 1000 },
    );
    publishId = init.publish_id;
  }

  // 4. Poll until done (TikTok processes asynchronously)
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    const st = await api<{ status: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number>; publicly_available_post_id?: Array<string | number> }>(
      creds,
      "/v2/post/publish/status/fetch/",
      { publish_id: publishId },
    );
    if (st.status === "PUBLISH_COMPLETE") {
      // TikTok's field is spelled "publicaly_available_post_id" in the API; accept both.
      const id = String((st.publicaly_available_post_id ?? st.publicly_available_post_id ?? [])[0] ?? publishId);
      const user = info.creator_username;
      const url = privacy === "SELF_ONLY" || !user ? null : `https://www.tiktok.com/@${user}/video/${id}`;
      log.info({ publishId, postId: id, privacy }, "tiktok published");
      return { platformPostId: id, platformPostUrl: url, privacy };
    }
    if (st.status === "FAILED") throw new Error(`TikTok publish FAILED: ${st.fail_reason ?? "unknown"}`);
  }
  throw new Error(`TikTok publish status timed out after ~5 min (publish_id=${publishId})`);
}
