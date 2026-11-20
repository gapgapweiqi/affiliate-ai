/**
 * "Orange cat" scene for product videos (VIDEO_STYLE=cat).
 *
 * Nano Banana (image edit on fal.ai) builds a new vertical 9:16 photo from
 * the Shopee product photo: the product stays unchanged in the foreground and
 * an orange tabby cat acts out the product's use in the background (ironing
 * for an iron, frying fish for an air fryer, …). Kling then animates it.
 *
 * Building a new scene also drops the seller's badges, price tags and QR codes
 * from the Shopee photo. Ask for "a new scene with no text overlays" rather
 * than "remove the watermark": the latter trips fal's content checker.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { complete } from "../lib/claude.ts";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { errMsg, sleep } from "../lib/retry.ts";
import { extractJson } from "./variant-generator.ts";

const log = child("content.cat-scene");
const QUEUE = "https://queue.fal.run";
const MODEL = "fal-ai/nano-banana/edit";
const COST_USD = 0.0398; // fal's published price per output image
const OUTPUT_DIR = "/tmp/affiliate-ai/video";

export interface CatSceneResult {
  path: string;
  /** fal-hosted URL of the scene image (good for the next fal call). */
  url: string;
  costUsd: number;
}

function headers(): Record<string, string> {
  return { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" };
}

export type SceneAspect = "9:16" | "4:5";

export function catScenePrompt(productType: string, scene: string, aspect: SceneAspect = "9:16"): string {
  return `${aspect === "9:16" ? "Vertical 9:16" : "Portrait 4:5"} product advertising photo.
Foreground: the exact product from the reference photo (${productType}), unchanged — same shape, colors, logo and printed text — placed in the lower half of the frame, sharp, well lit, centered, fully visible.
Copy the product faithfully: keep the same viewing angle, perspective and proportions as in the reference, and every part it has (lids, handles, arms, knobs, buttons, cables) exactly where it is. Do not redesign, simplify or re-imagine the product.
Use only the product itself from the reference; build a completely new scene around it with no text overlays.
Background, softly out of focus: one cute fluffy orange tabby cat. ${scene}
Photorealistic, warm natural light, shallow depth of field, clean and cozy.`;
}

export async function makeCatScene(opts: {
  productId: number;
  imageUrl: string;
  /** e.g. "a Philips steam iron" — Sonnet's short English name for the product. */
  productType: string;
  /** English: what the cat does and where (from Sonnet). */
  scene: string;
  /** 9:16 for Reels videos (default), 4:5 for feed photos. */
  aspect?: SceneAspect;
  timeoutMs?: number;
}): Promise<CatSceneResult> {
  if (!env.FAL_KEY) throw new Error("FAL_KEY is not set");
  const started = Date.now();
  const aspect = opts.aspect ?? "9:16";
  const prompt = catScenePrompt(opts.productType, opts.scene, aspect);
  const [run] = await db
    .insert(schema.generationRuns)
    .values({
      task: "image_gen.cat_scene",
      provider: "fal",
      model: MODEL,
      success: false,
      metadata: { productId: opts.productId, scene: opts.scene.slice(0, 300) },
    })
    .returning({ id: schema.generationRuns.id });

  try {
    const img = await fetch(opts.imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!img.ok) throw new Error(`image download ${img.status}`);
    const type = img.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const dataUri = `data:${type};base64,${Buffer.from(await img.arrayBuffer()).toString("base64")}`;

    const submit = await fetch(`${QUEUE}/${MODEL}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ prompt, image_urls: [dataUri], aspect_ratio: aspect, num_images: 1, output_format: "jpeg" }),
    });
    const q = (await submit.json()) as { status_url?: string; response_url?: string; detail?: unknown };
    if (!submit.ok || !q.status_url || !q.response_url) {
      throw new Error(`fal submit ${submit.status}: ${JSON.stringify(q.detail ?? q).slice(0, 300)}`);
    }
    const deadline = started + (opts.timeoutMs ?? 3 * 60 * 1000);
    for (;;) {
      await sleep(3000);
      const st = (await (await fetch(q.status_url, { headers: headers() })).json()) as { status?: string; error?: unknown };
      if (st.status === "COMPLETED") break;
      if (st.error || (st.status && !["IN_QUEUE", "IN_PROGRESS"].includes(st.status))) {
        throw new Error(`fal job ${st.status ?? "error"}: ${JSON.stringify(st.error ?? st).slice(0, 300)}`);
      }
      if (Date.now() > deadline) throw new Error(`cat scene timed out (${st.status})`);
    }
    const res = await fetch(q.response_url, { headers: headers() });
    const out = (await res.json()) as { images?: { url?: string }[]; detail?: unknown };
    const url = out.images?.[0]?.url;
    // Moderation refusals come back here as a 4xx "content_policy_violation".
    if (!res.ok || !url) throw new Error(`fal result ${res.status}: ${JSON.stringify(out.detail ?? out).slice(0, 300)}`);

    const file = await fetch(url);
    if (!file.ok) throw new Error(`scene download ${file.status}`);
    await mkdir(OUTPUT_DIR, { recursive: true });
    const path = join(OUTPUT_DIR, `product-${opts.productId}-catscene-${Date.now()}.jpg`);
    await writeFile(path, Buffer.from(await file.arrayBuffer()));

    await db
      .update(schema.generationRuns)
      .set({ success: true, durationMs: Date.now() - started, costUsdMicros: Math.round(COST_USD * 1_000_000) })
      .where(sql`id = ${run!.id}`);
    log.info({ productId: opts.productId, path, secs: (Date.now() - started) / 1000 }, "cat scene ready");
    return { path, url, costUsd: COST_USD };
  } catch (err) {
    await db
      .update(schema.generationRuns)
      .set({ success: false, durationMs: Date.now() - started, errorMsg: errMsg(err) })
      .where(sql`id = ${run!.id}`);
    throw err;
  }
}

const IDEA_SYSTEM = `You plan one photo for a Thai Facebook page that sells Shopee products.
The product stands unchanged in the foreground; in the softly blurred background one cute fluffy orange tabby cat acts out using that kind of product, in a matching setting (an iron → ironing a shirt in a laundry room; an air fryer → frying a fish in a kitchen; earbuds → bobbing its head to music on a sofa; sunscreen → lounging under a beach umbrella).
The cat uses its own small prop; it never touches, eats or sits on the product.
Say ok=false when a cat scene would be unsafe, misleading or in poor taste: medicine, supplements, health or medical devices, adult products, weapons, baby food or formula, pet food for animals other than cats, or a product the cat would have to eat or wear on its body.
Return ONLY JSON: {"ok": true, "product_type": "<short English name, e.g. a Philips steam iron>", "scene": "<English, 25-45 words: what the cat does, what it holds, the setting and light>"}`;

/** Haiku picks the cat's action for a product; null when a cat scene doesn't fit it. */
export async function catIdea(productId: number): Promise<{ productType: string; scene: string } | null> {
  const [p] = await db
    .select({ name: schema.products.name, brand: schema.products.brand, description: schema.products.description })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  if (!p) return null;
  const res = await complete({
    tier: "fast",
    system: IDEA_SYSTEM,
    prompt: JSON.stringify({ name: p.name, brand: p.brand, description: p.description?.slice(0, 600) ?? null }),
    maxTokens: 3000, // 5-family models think first
    task: "cat_scene_idea",
  });
  const j = extractJson<{ ok?: boolean; product_type?: string; scene?: string }>(res.text);
  return j?.ok && j.product_type && j.scene ? { productType: j.product_type.trim(), scene: j.scene.trim() } : null;
}

/**
 * Feed-photo version (PHOTO_STYLE=cat): a 4:5 cat scene for one product, or
 * null (no FAL_KEY, product not a fit, or the image model refused) so the
 * caller posts the plain Shopee photo instead.
 */
export async function catPhotoForPost(productId: number): Promise<string | null> {
  if (!env.FAL_KEY) return null;
  try {
    const [p] = await db
      .select({ image: schema.products.primaryImage })
      .from(schema.products)
      .where(eq(schema.products.id, productId))
      .limit(1);
    if (!p?.image || !/^https:\/\//.test(p.image)) return null;
    const idea = await catIdea(productId);
    if (!idea) {
      log.info({ productId }, "cat photo skipped for this product");
      return null;
    }
    const scene = await makeCatScene({ productId, imageUrl: p.image, ...idea, aspect: "4:5" });
    return scene.url;
  } catch (err) {
    log.warn({ productId, err: errMsg(err) }, "cat photo failed — posting the Shopee photo");
    return null;
  }
}
