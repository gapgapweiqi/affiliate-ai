/**
 * Product video via WanGP on the host GPU (tools/wangp-server/server.py).
 *
 * Two styles:
 *   "product"   — image-to-video straight from the scraped Shopee photo, so
 *                 the product in the clip is the real one; the model only
 *                 adds motion (text regions are protected server-side).
 *   "presenter" — Flux 2 Klein first composes a presenter holding the
 *                 product (Shopee photo as reference), then Wan animates
 *                 that frame; upscaled to 1080x1920 for Reels/TikTok.
 *
 * Returns a local MP4 path that publishers can upload directly.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { sleep } from "../lib/retry.ts";

const log = child("content.wangp");
const OUTPUT_DIR = "/tmp/affiliate-ai/video";

export type VideoStyle = "product" | "presenter";

export interface WanGPVideoOptions {
  productId: number;
  style?: VideoStyle;   // default "product"
  /** Override the motion prompt (English works best for Wan). */
  prompt?: string;
  seconds?: number;     // default 3 (product) / 4 (presenter)
  resolution?: string;  // "WxH"; default 480x832 (product) / 720x1280 (presenter)
  timeoutMs?: number;   // default 60 min for the whole run
  /** presenter style: image file on the WanGP server used as the presenter
   *  reference, so every video shows the same person. Default env WANGP_PRESENTER_FILE. */
  presenterFile?: string;
  /** presenter style: how she holds the product in the first frame (from the video script). */
  holdPose?: string;
}

interface JobStatus {
  status: "queued" | "running" | "done" | "error";
  file?: string;
  seconds_taken?: number;
  error?: string;
}

export interface WanGPVideoResult {
  path: string;
  remoteFile: string;
  secondsTaken: number;
  /** presenter style: the composed still frame (server file name). */
  frameFile?: string;
}

export function wanGPEnabled(): boolean {
  return Boolean(env.WANGP_URL);
}

function productPrompt(): string {
  // Locked-off camera: the server pastes the original text regions back
  // over every frame (protect_text), which only lines up if the framing
  // holds still. Motion comes from light and a gentle product move instead.
  // Also keeps the product itself unchanged so the clip doesn't misrepresent it.
  return [
    "Product commercial, static locked-off camera, the framing does not move.",
    "The product stays exactly as shown, same shape, color and logo,",
    "it gently floats and turns very slightly.",
    "A soft light sweep glides across its glossy surface, subtle glowing particles drift in the background,",
    "all graphics and text stay perfectly still. Sharp focus, high quality.",
  ].join(" ");
}

/**
 * Still frame for Flux 2 Klein. Casual "real user review" look (the style
 * the operator picked over a glossy studio ad). With a saved presenter the
 * first reference is her and the second the product; without one, Klein
 * invents a presenter and the only reference is the product.
 */
function presenterFramePrompt(withPresenterRef: boolean, holdPose?: string): string {
  const who = withPresenterRef
    ? "The same young woman as in the first reference image, same face, hair and look,"
    : "A friendly young Southeast Asian woman with long straight black hair, in a casual white t-shirt,";
  const what = withPresenterRef
    ? "the product from the second reference image"
    : "the product from the reference image";
  return [
    `Vertical smartphone photo for a social media product review. ${who}`,
    "eyes wide open looking directly into the camera lens with friendly eye contact, about to speak,",
    "lips slightly parted in a natural smile,",
    `${holdPose ? `${holdPose} — it is ${what}` : `holding ${what} in one hand beside her face`}, product facing the camera.`,
    "The product looks exactly like its reference: same shape, colors and details.",
    "Bright modern bedroom background, softly blurred, natural daylight from a window.",
    "Medium shot from waist up, presenter centered, product clearly visible, safe margins at the top and bottom.",
    "Realistic skin, natural makeup, sharp focus on her face and the product. No text, no logos, no watermark.",
  ].join(" ");
}

function presenterMotionPrompt(): string {
  return [
    "A friendly young woman filming a casual product review in her bright bedroom, holding the product toward the camera.",
    "Her eyes stay open and look straight into the camera lens the whole time with warm eye contact; she never looks down.",
    "She smiles, tilts her head slightly and raises the product a little closer to the camera.",
    "Natural subtle hand gestures, smooth relaxed body movement, blinking naturally.",
    "The product keeps exactly the same shape and colors. Natural daylight,",
    "handheld smartphone feel with very slight steady camera motion, realistic, high quality.",
  ].join(" ");
}

interface Ctx {
  base: string;
  deadline: number;
}

/** Submit a job and poll until it finishes. Generation takes minutes on a consumer GPU. */
async function runJob(ctx: Ctx, endpoint: "/generate" | "/task", body: unknown): Promise<JobStatus & { file: string }> {
  const res = await fetch(`${ctx.base}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const queued = (await res.json()) as { job?: string; error?: string };
  if (!res.ok || !queued.job) throw new Error(`WanGP ${res.status}: ${queued.error ?? "no job id"}`);
  for (;;) {
    await sleep(5_000);
    const data = (await (await fetch(`${ctx.base}/jobs/${queued.job}`)).json()) as JobStatus;
    if (data.status === "done" && data.file) return data as JobStatus & { file: string };
    if (data.status === "error" || data.status === "done") {
      throw new Error(`WanGP job failed: ${data.error ?? "no file"}`);
    }
    if (Date.now() > ctx.deadline) throw new Error(`WanGP job ${queued.job} timed out (${data.status})`);
  }
}

/** Scale to cover 1080x1920 and center-crop (no stretch). Inputs vary: FastWan ~704x1280, InfiniteTalk 480x848. */
function upscaleVertical1080(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-v", "error", "-y", "-i", input,
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920",
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      output,
    ]);
    let err = "";
    ff.stderr.on("data", (d) => {
      err += d;
    });
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
  });
}

function wangpBase(): string {
  const base = env.WANGP_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("WANGP_URL is not set");
  return base;
}

async function productImage(productId: number): Promise<string> {
  const [product] = await db
    .select({ image: schema.products.primaryImage })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  if (!product?.image) throw new Error(`product ${productId} has no image`);
  return product.image;
}

/** Flux 2 Klein: presenter (saved reference, if any) holding the product. Returns the server file name. */
async function composePresenterFrame(
  ctx: Ctx,
  productId: number,
  image: string,
  opts: { presenterFile?: string; holdPose?: string },
): Promise<string> {
  const presenterFile = opts.presenterFile ?? env.WANGP_PRESENTER_FILE;
  log.info({ productId, presenterFile }, "composing presenter frame (Flux 2 Klein)");
  const frame = await runJob(ctx, "/task", {
    settings: {
      model_type: "flux2_klein_4b",
      video_prompt_type: "I", // references = subjects only, so the 9:16 canvas is kept
      prompt: presenterFramePrompt(Boolean(presenterFile), opts.holdPose),
      resolution: "720x1280",
      num_inference_steps: 4,
    },
    image_refs_files: presenterFile ? [presenterFile] : [],
    image_refs_urls: [image],
  });
  return frame.file;
}

async function downloadResult(base: string, remote: string, localName: string): Promise<string> {
  const file = await fetch(`${base}/files/${encodeURIComponent(remote)}`);
  if (!file.ok) throw new Error(`WanGP download ${file.status}`);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, localName);
  await writeFile(path, Buffer.from(await file.arrayBuffer()));
  return path;
}

export async function generateProductVideo(opts: WanGPVideoOptions): Promise<WanGPVideoResult> {
  const base = wangpBase();
  const ctx: Ctx = { base, deadline: Date.now() + (opts.timeoutMs ?? 60 * 60 * 1000) };
  const style: VideoStyle = opts.style ?? "product";
  const image = await productImage(opts.productId);

  let frameFile: string | undefined;
  let genBody: Record<string, unknown>;
  if (style === "presenter") {
    frameFile = await composePresenterFrame(ctx, opts.productId, image, opts);
    genBody = {
      image_file: frameFile,
      prompt: opts.prompt ?? presenterMotionPrompt(),
      seconds: opts.seconds ?? 4,
      resolution: opts.resolution ?? "720x1280",
      protect_text: false,
    };
  } else {
    genBody = {
      image_url: image,
      prompt: opts.prompt ?? productPrompt(),
      seconds: opts.seconds ?? 3,
      resolution: opts.resolution ?? "480x832",
    };
  }
  log.info({ productId: opts.productId, style, ...genBody }, "requesting WanGP video");
  const data = await runJob(ctx, "/generate", genBody);

  let path = await downloadResult(base, data.file, `product-${opts.productId}-${style}-${data.file}`);
  if (style === "presenter") {
    const hd = path.replace(/\.mp4$/, "-1080x1920.mp4");
    await upscaleVertical1080(path, hd);
    path = hd;
  }

  log.info({ productId: opts.productId, style, path, secondsTaken: data.seconds_taken }, "WanGP video ready");
  return { path, remoteFile: data.file, secondsTaken: data.seconds_taken ?? 0, frameFile };
}

// Wan 2.1 I2V 14B 4-step distill LoRA — InfiniteTalk is built on that base.
const LIGHTX2V_I2V_14B =
  "https://huggingface.co/DeepBeepMeep/Wan2.1/resolve/main/loras_accelerators/Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors";

export interface TalkingVideoOptions {
  productId: number;
  /** Local voice file (MP3/WAV) the presenter lip-syncs to. */
  audioPath: string;
  audioSeconds: number;
  prompt: string;
  holdPose?: string;
  presenterFile?: string;
  timeoutMs?: number; // default 2 h — 14B on a 3060 is slow
}

/**
 * Presenter speaking the voiceover on camera: Klein frame → InfiniteTalk
 * (audio-driven lip-sync, 480p, sliding windows for any length) → 1080x1920.
 * The returned MP4's audio is whatever InfiniteTalk muxed; callers that need
 * the pristine voice should remux it.
 */
export async function generateTalkingVideo(opts: TalkingVideoOptions): Promise<WanGPVideoResult> {
  const base = wangpBase();
  const ctx: Ctx = { base, deadline: Date.now() + (opts.timeoutMs ?? 2 * 60 * 60 * 1000) };
  const image = await productImage(opts.productId);
  const frameFile = await composePresenterFrame(ctx, opts.productId, image, opts);

  const ext = opts.audioPath.toLowerCase().endsWith(".wav") ? "wav" : "mp3";
  const up = await fetch(`${base}/upload?ext=${ext}`, { method: "POST", body: await readFile(opts.audioPath) });
  const uploaded = (await up.json()) as { file?: string; error?: string };
  if (!up.ok || !uploaded.file) throw new Error(`WanGP upload ${up.status}: ${uploaded.error ?? ""}`);

  log.info({ productId: opts.productId, frameFile, audio: uploaded.file }, "requesting InfiniteTalk video");
  const data = await runJob(ctx, "/task", {
    settings: {
      model_type: "infinitetalk",
      prompt: opts.prompt,
      resolution: "480x832",
      video_length: `${Math.ceil(opts.audioSeconds + 0.5)}s`,
      sliding_window_size: 81, // InfiniteTalk needs 81 for smooth window joins
      activated_loras: [LIGHTX2V_I2V_14B],
      loras_multipliers: "1",
      num_inference_steps: 4,
      guidance_phases: 1,
      guidance_scale: 1,
      audio_guidance_scale: 1,
    },
    // InfiniteTalk wants the frame as both start image and reference
    image_start_file: frameFile,
    image_refs_files: [frameFile],
    audio_guide_file: uploaded.file,
  });

  const raw = await downloadResult(base, data.file, `product-${opts.productId}-talking-${data.file}`);
  const path = raw.replace(/\.mp4$/, "-1080x1920.mp4");
  await upscaleVertical1080(raw, path);
  log.info({ productId: opts.productId, path, secondsTaken: data.seconds_taken }, "talking video ready");
  return { path, remoteFile: data.file, secondsTaken: data.seconds_taken ?? 0, frameFile };
}
