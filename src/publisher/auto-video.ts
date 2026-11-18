/**
 * Daily auto video post (scheduled 22:30 BKK by default).
 *
 * Picks the best product that hasn't had a video recently, runs the voiced
 * product-video pipeline (Sonnet → ElevenLabs → WanGP on the host GPU →
 * ffmpeg) and publishes it to Facebook with its own gated caption.
 *
 * Skips quietly when WanGP isn't configured or reachable (the host PC may be
 * off). Honours DEBUG_DRY_RUN through publishToFacebook, like every post.
 */

import { sql } from "drizzle-orm";
import { makeVoicedProductVideo } from "../content/video-pipeline.ts";
import { db } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { errMsg } from "../lib/retry.ts";
import { publishToFacebook } from "./facebook.ts";

const log = child("publisher.auto-video");
/** Don't make another video for the same product within this many days. */
const VIDEO_COOLDOWN_DAYS = 7;

export interface AutoVideoResult {
  status: "posted" | "dry_run" | "skipped" | "failed";
  productId?: number;
  reason?: string;
  postUrl?: string | null;
  videoPath?: string;
}

async function wanGPReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${env.WANGP_URL!.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function pickProduct(): Promise<number | null> {
  const [row] = await db.execute<{ id: number; [k: string]: unknown }>(sql`
    SELECT p.id FROM products p
    WHERE p.is_active AND NOT p.flag_blacklisted
      AND p.primary_image LIKE 'https://%'
      AND COALESCE(p.final_score, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM published_posts pp
        WHERE pp.product_id = p.id AND pp.channel = 'facebook'
          AND pp.video_url IS NOT NULL
          AND pp.created_at > NOW() - (${VIDEO_COOLDOWN_DAYS} || ' days')::interval
      )
    ORDER BY p.final_score DESC, p.first_seen_at DESC
    LIMIT 1
  `);
  return row?.id ?? null;
}

export async function runAutoVideoPost(): Promise<AutoVideoResult> {
  if (!env.WANGP_URL) return { status: "skipped", reason: "WANGP_URL not set" };
  if (!(await wanGPReachable())) return { status: "skipped", reason: "WanGP server not reachable (host PC off?)" };

  const productId = await pickProduct();
  if (!productId) return { status: "skipped", reason: "no eligible product" };

  try {
    const video = await makeVoicedProductVideo(productId);
    if (!video.content.variantId) {
      return {
        status: "skipped",
        productId,
        videoPath: video.path,
        reason: `caption rejected by Quality Gate: ${video.content.gateIssues.join("; ")}`,
      };
    }
    const res = await publishToFacebook({ productId, videoPath: video.path, variantId: video.content.variantId });
    if (res.status !== "published") {
      return { status: "failed", productId, videoPath: video.path, reason: res.errorMsg ?? res.status };
    }
    return { status: res.dryRun ? "dry_run" : "posted", productId, postUrl: res.platformPostUrl, videoPath: video.path };
  } catch (err) {
    log.error({ productId, err: errMsg(err) }, "auto video post failed");
    return { status: "failed", productId, reason: errMsg(err) };
  }
}
