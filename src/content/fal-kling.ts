/**
 * Product clip via Kling on fal.ai (default: Kling 2.5 Turbo Pro, image-to-video).
 *
 * Cloud alternative to the local WanGP server: no GPU needed, so the video
 * job also runs on a plain Ubuntu server. The Shopee photo is the first
 * frame, so the product in the clip is the real one.
 *
 * Uses fal's REST queue directly (no SDK): submit → poll status → fetch result.
 *   POST https://queue.fal.run/<model>          Authorization: Key $FAL_KEY
 *   GET  <status_url>   → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
 *   GET  <response_url> → { video: { url } }
 *
 * Pricing (fal page, Nov 2026): $0.35 for 5 s + $0.07 per extra second
 * → 10 s = $0.70. Logged to generation_runs for the dashboard.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { errMsg, sleep } from "../lib/retry.ts";

const log = child("content.fal-kling");
const QUEUE = "https://queue.fal.run";
const OUTPUT_DIR = "/tmp/affiliate-ai/video";

export interface KlingClipOptions {
  productId: number;
  imageUrl: string;
  prompt: string;
  seconds: 5 | 10;
  negativePrompt?: string;
  timeoutMs?: number; // default 15 min
}

export interface KlingClipResult {
  path: string;
  remoteUrl: string;
  costUsd: number;
  secondsTaken: number;
}

export function falEnabled(): boolean {
  return Boolean(env.FAL_KEY);
}

/**
 * Cost for one clip, from fal's published Kling 2.5 Turbo pricing:
 * Pro $0.35 per 5 s + $0.07/s, Standard (720p) $0.21 per 5 s + $0.042/s.
 */
export function klingCostUsd(seconds: number, model: string = env.FAL_KLING_MODEL): number {
  const [base, perSec] = model.includes("/standard/") ? [0.21, 0.042] : [0.35, 0.07];
  return base + Math.max(0, seconds - 5) * perSec;
}

function headers(): Record<string, string> {
  return { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" };
}

/**
 * Send the photo inline (data URI) rather than the Shopee CDN URL: some
 * hosts block or rate-limit fetches from cloud workers.
 */
async function imageAsDataUri(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`image download ${res.status}`);
  const type = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  return `data:${type};base64,${b64}`;
}

export async function generateKlingClip(opts: KlingClipOptions): Promise<KlingClipResult> {
  if (!env.FAL_KEY) throw new Error("FAL_KEY is not set");
  const model = env.FAL_KLING_MODEL;
  const started = Date.now();
  const costUsd = klingCostUsd(opts.seconds, model);

  const [run] = await db
    .insert(schema.generationRuns)
    .values({
      task: "video_gen.kling",
      provider: "fal",
      model,
      success: false,
      metadata: { productId: opts.productId, seconds: opts.seconds },
    })
    .returning({ id: schema.generationRuns.id });

  try {
    const submit = await fetch(`${QUEUE}/${model}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        prompt: opts.prompt,
        image_url: await imageAsDataUri(opts.imageUrl),
        duration: String(opts.seconds),
        negative_prompt:
          opts.negativePrompt ??
          "blur, distort, low quality, deformed product, changed logo, garbled text, extra objects, watermark",
        cfg_scale: 0.5,
      }),
    });
    const queued = (await submit.json()) as { request_id?: string; status_url?: string; response_url?: string; detail?: unknown };
    if (!submit.ok || !queued.status_url || !queued.response_url) {
      throw new Error(`fal submit ${submit.status}: ${JSON.stringify(queued.detail ?? queued).slice(0, 300)}`);
    }
    log.info({ productId: opts.productId, requestId: queued.request_id, model, seconds: opts.seconds }, "kling clip queued");

    const deadline = started + (opts.timeoutMs ?? 15 * 60 * 1000);
    for (;;) {
      await sleep(5000);
      const st = (await (await fetch(queued.status_url, { headers: headers() })).json()) as { status?: string; error?: unknown };
      if (st.status === "COMPLETED") break;
      if (st.error || (st.status && !["IN_QUEUE", "IN_PROGRESS"].includes(st.status))) {
        throw new Error(`fal job ${st.status ?? "error"}: ${JSON.stringify(st.error ?? st).slice(0, 300)}`);
      }
      if (Date.now() > deadline) throw new Error(`fal job ${queued.request_id} timed out (${st.status})`);
    }

    const resultRes = await fetch(queued.response_url, { headers: headers() });
    const result = (await resultRes.json()) as { video?: { url?: string }; detail?: unknown };
    const url = result.video?.url;
    if (!resultRes.ok || !url) throw new Error(`fal result ${resultRes.status}: ${JSON.stringify(result.detail ?? result).slice(0, 300)}`);

    const file = await fetch(url);
    if (!file.ok) throw new Error(`clip download ${file.status}`);
    await mkdir(OUTPUT_DIR, { recursive: true });
    const path = join(OUTPUT_DIR, `product-${opts.productId}-kling-${Date.now()}.mp4`);
    await writeFile(path, Buffer.from(await file.arrayBuffer()));

    const secondsTaken = Math.round((Date.now() - started) / 1000);
    await db
      .update(schema.generationRuns)
      .set({ success: true, durationMs: Date.now() - started, costUsdMicros: Math.round(costUsd * 1_000_000) })
      .where(sql`id = ${run!.id}`);
    log.info({ productId: opts.productId, path, secondsTaken, costUsd }, "kling clip ready");
    return { path, remoteUrl: url, costUsd, secondsTaken };
  } catch (err) {
    await db
      .update(schema.generationRuns)
      .set({ success: false, durationMs: Date.now() - started, errorMsg: errMsg(err) })
      .where(sql`id = ${run!.id}`);
    throw err;
  }
}
