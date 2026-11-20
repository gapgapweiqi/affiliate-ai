/**
 * Video content writer — Sonnet turns a product into everything one video
 * post needs, in a single call:
 *
 *   1. a short Thai voiceover (read by ElevenLabs),
 *   2. two English shot prompts for WanGP product clips (the Shopee photo
 *      animated; camera locked so printed text can be protected), and
 *   3. the Facebook caption + hashtags, with this post's own tracked link.
 *
 * The caption goes through the Quality Gate and is saved as a
 * content_variant with its own affiliate link, so clicks on the video post
 * are attributed like any other caption.
 */

import { eq } from "drizzle-orm";
import { createAffiliateLink } from "../affiliate/link-generator.ts";
import { complete } from "../lib/claude.ts";
import { db, schema } from "../lib/db.ts";
import { child } from "../lib/logger.ts";
import { runQualityGate } from "../quality/gate.ts";
import { extractJson } from "./variant-generator.ts";

const log = child("content.video-script");

export interface VideoContent {
  /** Thai narration, ~9-12 s when read aloud. */
  voiceover: string;
  /** English WanGP prompts, one per clip, in playback order. */
  shots: string[];
  /** Caption as posted (after Quality Gate auto-fixes). */
  caption: string;
  hashtags: string[];
  /** content_variants row holding the caption; null if the gate rejected it. */
  variantId: number | null;
  gateApproved: boolean;
  gateIssues: string[];
  costUsd: number;
}

interface Parsed {
  voiceover: string;
  shots: string[];
  caption: string;
  hashtags?: string[];
}

/**
 * How the clip will be made — the voiceover length and shot list must fit it.
 *   kling: one 10 s Kling clip; the camera may drift slowly (no text paste-back).
 *   wangp: two ~5 s WanGP clips with a locked camera (printed text is pasted back).
 */
export interface ShotPlan {
  provider: "kling" | "wangp";
}

const PLAN_TEXT: Record<ShotPlan["provider"], { voice: string; shots: string }> = {
  kling: {
    voice: "- 80-110 Thai characters (at most 9 seconds read aloud — the clip is 10 seconds). Natural spoken Thai, warm and persuasive, like a friend who found a good deal.",
    shots: `2) "shots" — exactly 1 English prompt for a single 10-second image-to-video clip.
- One continuous shot: a slow, smooth camera push-in or gentle orbit, OR a locked camera — pick what suits the product. No cuts, no fast moves.
- Motion: the product turning slowly or floating gently, a soft light sweep and glints across its surface, subtle bokeh or particles in the background. 2-3 beats that follow the voiceover.
- The product stays the hero, centered and fully in frame; no hands, no people, no new objects.`,
  },
  wangp: {
    voice: "- 110-160 Thai characters (about 9-12 seconds read aloud). Natural spoken Thai, warm and persuasive, like a friend who found a good deal.",
    shots: `2) "shots" — exactly 2 English prompts for the image-to-video model, one per ~5 second clip, in order.
- The camera is LOCKED OFF (static framing, no pan, no zoom, no orbit) — printed text in the photo is pasted back afterwards, so the frame must not move.
- Motion comes from: the product gently floating / turning very slightly, soft light sweeps across its surface, glints, subtle glowing particles or bokeh in the background.
- Make the two shots feel different (e.g. shot 1 a light sweep + glint, shot 2 a gentle float with soft glow) and match the mood of the voiceover.`,
  },
};

function buildSystem(plan: ShotPlan): string {
  const t = PLAN_TEXT[plan.provider];
  return SYSTEM_TEMPLATE.replace("{{VOICE_LENGTH}}", t.voice).replace("{{SHOTS}}", t.shots);
}

const SYSTEM_TEMPLATE = `You are a senior Thai social-commerce copywriter. You create short vertical product videos for a Facebook page that sells Shopee products through affiliate links.
The video shows ONLY the product (no people): its Shopee product photo is animated by an image-to-video model, with a Thai voiceover on top.

Write three things:

1) "voiceover" — Thai narration for the video.
{{VOICE_LENGTH}}
- Structure: hook in the first 2 seconds → 1-2 concrete benefits from the product data → price (and the discount if any) → soft call to action (e.g. "กดลิงก์ในโพสต์ได้เลย").
- Write numbers as words a TTS reads well ("เก้าสิบเก้าบาท", "สี่จุดหก").
- No emoji, no hashtags, no URLs.

{{SHOTS}}
- You cannot see the photo: never describe the product's color, material or look — just call it "the product" (or its type, e.g. "the earbuds and charging case").
- Always say the product keeps exactly the same shape, color, logo and printed text. 35-60 words each.

3) "caption" + "hashtags" — the Facebook post text.
- Thai, 150-350 characters. Line 1 is a scroll-stopping hook. Then 2-3 short lines with the key benefits and the price (use digits here, e.g. 99 บาท), then the call to action with the link.
- Include the affiliate URL given in the input exactly once, near the end.
- Light emoji is fine (max 3). Put hashtags in "hashtags" (3-5 Thai/English tags, include #affiliate), not in the caption.

Hard rules for everything: only claim what the product data supports; no invented specs, no medical/health claims, no "ดีที่สุด"/"อันดับ 1", no fake urgency or fake scarcity.

Return ONLY JSON:
{"voiceover": "...", "shots": ["...", "..."], "caption": "...", "hashtags": ["#...", "..."]}`;

export async function writeVideoContent(
  productId: number,
  plan: ShotPlan = { provider: "wangp" },
): Promise<VideoContent> {
  const [p] = await db
    .select({
      id: schema.products.id,
      name: schema.products.name,
      brand: schema.products.brand,
      price: schema.products.currentPrice,
      original: schema.products.originalPrice,
      discount: schema.products.discountPercent,
      rating: schema.products.rating,
      ratingCount: schema.products.ratingCount,
      soldCount: schema.products.soldCount,
      description: schema.products.description,
    })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  if (!p) throw new Error(`product ${productId} not found`);

  // Link first, so the caption carries this post's own tracked URL.
  const link = await createAffiliateLink({
    productId,
    channel: "facebook",
    campaign: `video_${new Date().toISOString().slice(0, 10)}`,
    variant: "V",
  });

  const facts = {
    name: p.name,
    brand: p.brand,
    price_baht: p.price != null ? p.price / 100 : null,
    original_price_baht: p.original != null ? p.original / 100 : null,
    discount_percent: p.discount != null ? Math.round(p.discount * 100) : null,
    rating: p.rating,
    rating_count: p.ratingCount,
    sold_count: p.soldCount,
    description: p.description?.slice(0, 1200) ?? null,
    affiliate_url: link.shortUrl,
  };

  let costUsd = 0;
  let found: Parsed | null = null;
  let model = "";
  for (let attempt = 1; attempt <= 2 && !found; attempt++) {
    const res = await complete({
      tier: "smart",
      system: buildSystem(plan),
      prompt: `Product data (JSON):\n${JSON.stringify(facts, null, 2)}`,
      maxTokens: 6000, // 5-family models think before answering; leave room
      task: "video_content",
    });
    costUsd += res.costUsd;
    model = res.model;
    const j = extractJson<Partial<Parsed>>(res.text);
    if (j?.voiceover && j.caption && Array.isArray(j.shots) && j.shots.length > 0) found = j as Parsed;
    else log.warn({ productId, attempt, stopReason: res.stopReason, raw: res.text.slice(0, 200) }, "video content parse failed");
  }
  if (!found) throw new Error("could not parse video content from Claude");
  const parsed: Parsed = found;

  const caption = parsed.caption.includes(link.shortUrl)
    ? parsed.caption
    : `${parsed.caption.trim()}\n${link.shortUrl}`;
  const hashtags = (parsed.hashtags ?? []).slice(0, 5);
  const postText = hashtags.length ? `${caption}\n\n${hashtags.join(" ")}` : caption;

  const gate = await runQualityGate({ text: postText, platform: "facebook" });
  costUsd += gate.llmCostUsd;

  const existing = await db
    .select({ code: schema.contentVariants.variantCode })
    .from(schema.contentVariants)
    .where(eq(schema.contentVariants.productId, productId));
  const n = existing.filter((r) => r.code.startsWith("V")).length + 1;

  const [row] = await db
    .insert(schema.contentVariants)
    .values({
      productId,
      channel: "facebook",
      angle: "deal",
      variantCode: `V${n}`.slice(0, 8),
      caption: gate.finalText,
      hashtags,
      hook: caption.split("\n")[0]?.slice(0, 200) ?? null,
      llmModel: model,
      gateApproved: gate.approved,
      gateIssues: gate.approved ? [] : gate.issues,
    })
    .returning({ id: schema.contentVariants.id });
  await db
    .update(schema.affiliateLinks)
    .set({ contentVariantId: row!.id })
    .where(eq(schema.affiliateLinks.id, link.affiliateLinkId));

  log.info(
    { productId, variantId: row!.id, approved: gate.approved, costUsd: costUsd.toFixed(4) },
    "video content written",
  );
  return {
    voiceover: parsed.voiceover.trim(),
    shots: parsed.shots.slice(0, plan.provider === "kling" ? 1 : 3).map((s) => s.trim()),
    caption: gate.finalText,
    hashtags,
    variantId: gate.approved ? row!.id : null,
    gateApproved: gate.approved,
    gateIssues: gate.approved ? [] : gate.issues,
    costUsd,
  };
}
