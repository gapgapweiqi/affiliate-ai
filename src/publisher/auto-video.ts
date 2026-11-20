/**
 * Daily auto video post (scheduled 22:30 BKK by default).
 *
 * Picks the best product that hasn't had a video recently, runs the voiced
 * product-video pipeline (Sonnet → ElevenLabs → Kling on fal.ai or WanGP on
 * the host GPU → ffmpeg) and publishes it to Facebook with its own gated caption.
 *
 * Skips quietly when no video provider is configured, or when WanGP is the
 * provider and the host PC is off. Honours DEBUG_DRY_RUN through
 * publishToFacebook, like every post.
 */

import { eq, sql } from "drizzle-orm";
import { makeVoicedProductVideo, videoProvider } from "../content/video-pipeline.ts";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { errMsg } from "../lib/retry.ts";
import { runQualityGate } from "../quality/gate.ts";
import { publishToFacebook } from "./facebook.ts";
import { publishToTikTok } from "./tiktok.ts";

const log = child("publisher.auto-video");
/** Don't make another video for the same product within this many days. */
const VIDEO_COOLDOWN_DAYS = 7;

export interface AutoVideoResult {
  status: "posted" | "dry_run" | "skipped" | "failed";
  productId?: number;
  reason?: string;
  postUrl?: string | null;
  videoPath?: string;
  /** Same clip on TikTok (when FEATURE_TIKTOK_AUTO_POST=true). */
  tiktok?: { status: string; dryRun?: boolean; privacy?: string; postUrl?: string | null; reason?: string };
}

/**
 * TikTok caption from the Facebook one: links in TikTok captions aren't
 * clickable, so drop the URL and point to the profile link instead.
 */
export async function tiktokVariant(productId: number, fbVariantId: number): Promise<number | null> {
  const [fb] = await db.select().from(schema.contentVariants).where(eq(schema.contentVariants.id, fbVariantId)).limit(1);
  if (!fb) return null;
  const body = fb.caption
    .replace(/https?:\/\/\S+/g, "")
    .split("\n")
    .map((l) => l.replace(/\s*👉\s*$/u, "").trimEnd())
    .filter((l, i, a) => l.trim() !== "" || (i > 0 && a[i - 1]!.trim() !== ""))
    .join("\n")
    .trim();
  // "link in profile" goes above the trailing hashtag block, if there is one.
  const lines = body.split("\n");
  let cut = lines.length;
  while (cut > 0 && /^(#\S+\s*)+$/u.test(lines[cut - 1]!.trim())) cut--;
  const head = lines.slice(0, cut).join("\n").trimEnd();
  const tags = lines.slice(cut).join("\n").trim();
  const text = `${head}\n🔗 ลิงก์สินค้าอยู่ที่โปรไฟล์${tags ? `\n\n${tags}` : ""}`;
  const gate = await runQualityGate({ text, platform: "tiktok" });
  const [row] = await db
    .insert(schema.contentVariants)
    .values({
      productId,
      channel: "tiktok",
      angle: fb.angle,
      variantCode: `T${fb.variantCode}`.slice(0, 8),
      caption: gate.finalText,
      hashtags: fb.hashtags ?? [],
      hook: fb.hook,
      llmModel: fb.llmModel,
      gateApproved: gate.approved,
      gateIssues: gate.approved ? [] : gate.issues,
    })
    .returning({ id: schema.contentVariants.id });
  if (!gate.approved) log.warn({ productId, issues: gate.issues }, "TikTok caption rejected by Quality Gate");
  return gate.approved ? row!.id : null;
}

async function postToTikTok(productId: number, fbVariantId: number, videoPath: string): Promise<AutoVideoResult["tiktok"]> {
  try {
    const variantId = await tiktokVariant(productId, fbVariantId);
    if (!variantId) return { status: "skipped", reason: "TikTok caption rejected by Quality Gate" };
    const r = await publishToTikTok({ productId, videoPath, variantId });
    return { status: r.status, dryRun: r.dryRun, privacy: r.privacy, postUrl: r.platformPostUrl, reason: r.errorMsg };
  } catch (err) {
    log.error({ productId, err: errMsg(err) }, "tiktok video post failed");
    return { status: "failed", reason: errMsg(err) };
  }
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
  const provider = videoProvider();
  if (!provider) return { status: "skipped", reason: "no video provider (set FAL_KEY or WANGP_URL)" };
  if (provider === "wangp" && !(await wanGPReachable())) {
    return { status: "skipped", reason: "WanGP server not reachable (host PC off?)" };
  }

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
    // TikTok gets the same clip whether or not Facebook succeeded.
    const tiktok = env.FEATURE_TIKTOK_AUTO_POST
      ? await postToTikTok(productId, video.content.variantId, video.path)
      : undefined;
    if (res.status !== "published") {
      return { status: "failed", productId, videoPath: video.path, reason: res.errorMsg ?? res.status, tiktok };
    }
    return { status: res.dryRun ? "dry_run" : "posted", productId, postUrl: res.platformPostUrl, videoPath: video.path, tiktok };
  } catch (err) {
    log.error({ productId, err: errMsg(err) }, "auto video post failed");
    return { status: "failed", productId, reason: errMsg(err) };
  }
}
