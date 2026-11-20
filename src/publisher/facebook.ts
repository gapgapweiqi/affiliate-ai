/**
 * Facebook Page publisher (M5 — Sprint 5).
 *
 * Posts to Facebook Page via Meta Graph API v21.0.
 *
 *   Text-only:    POST /{page-id}/feed       { message }
 *   With image:   POST /{page-id}/photos     { url, caption, published }
 *   With video:   POST /{page-id}/videos     { file_url, description }
 *   Local video:  POST graph-video…/{page-id}/videos  multipart { source, description }
 *
 * Uses long-lived Page Access Token (META_PAGE_ACCESS_TOKEN).
 * Token lifecycle: 60 days → must refresh before expiry. M0 health
 * check should monitor token expiry (Sprint 7+).
 *
 * DRY-RUN MODE: when META_PAGE_ACCESS_TOKEN is missing OR DEBUG_DRY_RUN=true,
 * skips the actual API call and returns a synthetic fake postId. Lets the
 * full pipeline (variant pick → publish → log) be tested end-to-end before
 * Meta credentials arrive.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { errMsg, retry } from "../lib/retry.ts";
import { loadVariant, pickVariant } from "./variant-picker.ts";
import { withDefaultImage } from "./media.ts";

const log = child("publisher.facebook");
const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const GRAPH_VIDEO_BASE = "https://graph-video.facebook.com/v21.0";

export interface PublishToFacebookOptions {
  productId: number;
  imageUrl?: string;     // optional: post with image
  videoUrl?: string;     // optional: post with video (MP4)
  /** optional: local MP4 uploaded directly (no public URL needed), e.g. from WanGP. */
  videoPath?: string;
  /** Post this exact variant instead of letting the bandit pick (e.g. a video's own caption). */
  variantId?: number;
  scheduledAt?: Date;    // future: schedule for later
  /** Override env DEBUG_DRY_RUN — useful for tests. */
  forceDryRun?: boolean;
}

export interface PublishResult {
  publishedPostId: number;       // our DB row id
  platformPostId: string | null; // FB's post id (or fake_<uuid> in dry-run)
  platformPostUrl: string | null;
  status: "published" | "failed" | "rate_limited" | "queued";
  variantId: number | null;
  dryRun: boolean;
  errorMsg?: string;
}

interface FbApiPostResponse {
  id?: string;
  post_id?: string;
  error?: {
    message: string;
    type: string;
    code: number;
    fbtrace_id?: string;
  };
}

function isDryRunMode(opts: PublishToFacebookOptions): boolean {
  if (opts.forceDryRun) return true;
  if (env.DEBUG_DRY_RUN) return true;
  if (!env.META_PAGE_ACCESS_TOKEN || !env.META_PAGE_ID) return true;
  return false;
}

/**
 * Pick a variant + publish it to FB. Logs to published_posts regardless of mode.
 */
export async function publishToFacebook(opts: PublishToFacebookOptions): Promise<PublishResult> {
  opts = await withDefaultImage(opts);
  // 1. Pick variant
  const variant = opts.variantId
    ? await loadVariant(opts.variantId, "facebook")
    : await pickVariant(opts.productId, "facebook");
  if (!variant) {
    log.warn({ productId: opts.productId }, "no approved facebook variant — generate first");
    // Insert failed row so the operator can see we tried
    const [row] = await db
      .insert(schema.publishedPosts)
      .values({
        productId: opts.productId,
        channel: "facebook",
        status: "failed",
        failureReason: "no approved variant exists",
        failedAt: new Date(),
        dryRun: isDryRunMode(opts),
      })
      .returning({ id: schema.publishedPosts.id });
    return {
      publishedPostId: row!.id,
      platformPostId: null,
      platformPostUrl: null,
      status: "failed",
      variantId: null,
      dryRun: isDryRunMode(opts),
      errorMsg: "no approved variant",
    };
  }

  const dryRun = isDryRunMode(opts);

  // 2. Insert "publishing" row
  const [postRow] = await db
    .insert(schema.publishedPosts)
    .values({
      contentVariantId: variant.id,
      productId: opts.productId,
      channel: "facebook",
      status: "publishing",
      captionPosted: variant.caption,
      imageUrl: opts.imageUrl ?? null,
      videoUrl: opts.videoUrl ?? (opts.videoPath ? `file:${basename(opts.videoPath)}` : null),
      dryRun,
    })
    .returning({ id: schema.publishedPosts.id });
  const publishedPostId = postRow!.id;

  // 3. Call Meta API (or simulate)
  let platformPostId: string | null = null;
  let platformPostUrl: string | null = null;
  let status: PublishResult["status"] = "published";
  let errorMsg: string | undefined;

  if (dryRun) {
    platformPostId = `fake_${crypto.randomUUID()}`;
    platformPostUrl = `https://www.facebook.com/${env.META_PAGE_ID ?? "DRYRUN_PAGE"}/posts/${platformPostId}`;
    log.info(
      {
        publishedPostId,
        productId: opts.productId,
        variantId: variant.id,
        captionLen: variant.caption.length,
        hasImage: Boolean(opts.imageUrl),
        hasVideo: Boolean(opts.videoUrl || opts.videoPath),
      },
      "[DRY-RUN] would publish to Facebook",
    );
  } else {
    try {
      const result = await callMetaApi(variant.caption, opts);
      platformPostId = result.platformPostId;
      platformPostUrl = result.platformPostUrl;
    } catch (err) {
      const msg = errMsg(err);
      status = msg.includes("rate") || msg.includes("throttl") ? "rate_limited" : "failed";
      errorMsg = msg;
      log.error({ publishedPostId, err: msg }, "facebook publish failed");
    }
  }

  // 4. Update row with final status
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

  return {
    publishedPostId,
    platformPostId,
    platformPostUrl,
    status,
    variantId: variant.id,
    dryRun,
    errorMsg,
  };
}

let pageTokenCache: { configured: string; page: string } | null = null;

/**
 * META_PAGE_ACCESS_TOKEN may hold either a Page token or a (long-lived)
 * user token of a Page admin. Page endpoints reject user tokens, so ask the
 * Graph API for the Page's own token. A Page token derived from a long-lived
 * user token does not expire. If the lookup returns nothing, the configured
 * token is already a Page token.
 */
export async function resolvePageToken(pageId: string, configured: string): Promise<string> {
  if (pageTokenCache?.configured === configured) return pageTokenCache.page;
  let page = configured;
  try {
    const res = await fetch(`${GRAPH_BASE}/${pageId}?fields=access_token&access_token=${encodeURIComponent(configured)}`);
    const data = (await res.json()) as { access_token?: string };
    if (data.access_token) {
      page = data.access_token;
      log.info({ pageId }, "using Page token derived from the configured user token");
    }
  } catch (err) {
    log.warn({ err: errMsg(err) }, "page token lookup failed — using configured token as-is");
  }
  pageTokenCache = { configured, page };
  return page;
}

/**
 * Real Meta Graph API call. Only invoked when token is present + not dry-run.
 */
async function callMetaApi(
  caption: string,
  opts: PublishToFacebookOptions,
): Promise<{ platformPostId: string; platformPostUrl: string | null }> {
  const pageId = env.META_PAGE_ID!;
  const token = await resolvePageToken(pageId, env.META_PAGE_ACCESS_TOKEN!);

  let endpoint: string;
  let body: Record<string, string>;

  if (opts.videoPath) {
    return uploadLocalVideo(caption, opts.videoPath, pageId, token);
  }

  if (opts.videoUrl) {
    endpoint = `${GRAPH_BASE}/${pageId}/videos`;
    body = {
      file_url: opts.videoUrl,
      description: caption,
      access_token: token,
    };
  } else if (opts.imageUrl) {
    endpoint = `${GRAPH_BASE}/${pageId}/photos`;
    body = {
      url: opts.imageUrl,
      caption: caption,
      published: "true",
      access_token: token,
    };
  } else {
    endpoint = `${GRAPH_BASE}/${pageId}/feed`;
    body = {
      message: caption,
      access_token: token,
    };
  }

  const json = await retry(
    async () => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });
      const data = (await res.json()) as FbApiPostResponse;
      if (data.error) {
        throw new Error(`Meta API error ${data.error.code}: ${data.error.message}`);
      }
      return data;
    },
    { attempts: 2, baseDelayMs: 1000 },
  );

  const platformPostId = json.post_id ?? json.id ?? "";
  const platformPostUrl = platformPostId
    ? `https://www.facebook.com/${pageId}/posts/${platformPostId.split("_")[1] ?? platformPostId}`
    : null;
  return { platformPostId, platformPostUrl };
}

/** Multipart upload of a local MP4 — Meta fetches nothing, so no public hosting needed. */
async function uploadLocalVideo(
  caption: string,
  videoPath: string,
  pageId: string,
  token: string,
): Promise<{ platformPostId: string; platformPostUrl: string | null }> {
  const bytes = await readFile(videoPath);
  const form = new FormData();
  form.set("access_token", token);
  form.set("description", caption);
  form.set("source", new Blob([bytes], { type: "video/mp4" }), basename(videoPath));

  const res = await fetch(`${GRAPH_VIDEO_BASE}/${pageId}/videos`, { method: "POST", body: form });
  const data = (await res.json()) as FbApiPostResponse;
  if (data.error) throw new Error(`Meta API error ${data.error.code}: ${data.error.message}`);
  const videoId = data.id ?? "";
  return {
    platformPostId: videoId,
    platformPostUrl: videoId ? `https://www.facebook.com/${pageId}/videos/${videoId}` : null,
  };
}
