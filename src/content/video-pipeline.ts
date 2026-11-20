/**
 * Voiced product video, end to end:
 *
 *   product ─► Sonnet: Thai voiceover + 2 shot prompts + FB caption
 *              (caption gated + saved as a content_variant with its own link)
 *           ─► ElevenLabs voice (MP3)
 *           ─► clip(s) from the Shopee photo, by VIDEO_PROVIDER:
 *                kling — one 10 s Kling 2.5 Turbo Pro clip on fal.ai (cloud, no GPU)
 *                wangp — one ~5 s WanGP clip per shot on the host GPU
 *                        (locked camera, printed text protected server-side)
 *           ─► ffmpeg: crossfade the clips, fit them to the voice length,
 *              lay them on a 1080x1920 canvas (blurred fill), mux the voice
 *
 * Shopee photos are square, so the vertical frame is filled with a blurred,
 * zoomed copy of the same footage behind the sharp centred clip.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { child } from "../lib/logger.ts";
import { makeCatScene } from "./cat-scene.ts";
import { generateKlingClip } from "./fal-kling.ts";
import { type VideoContent, writeVideoContent } from "./video-script.ts";
import { generateVoice } from "./voice-generator.ts";
import { generateProductVideo } from "./wangp-client.ts";

const log = child("content.video-pipeline");
const OUTPUT_DIR = "/tmp/affiliate-ai/video";
const MAX_CLIP_SEC = 5;
const XFADE_SEC = 0.5;

export type VideoProvider = "kling" | "wangp";

/** Which clip generator to use, or null when none is configured (the video job then skips). */
export function videoProvider(): VideoProvider | null {
  const want = env.VIDEO_PROVIDER;
  if (want === "kling") return env.FAL_KEY ? "kling" : null;
  if (want === "wangp") return env.WANGP_URL ? "wangp" : null;
  if (env.FAL_KEY) return "kling";
  if (env.WANGP_URL) return "wangp";
  return null;
}

export interface VoicedVideoResult {
  provider: VideoProvider;
  path: string;          // final 1080x1920 MP4 with audio
  content: VideoContent; // voiceover, shots, caption, variantId
  voicePath: string;
  voiceSec: number;
  voiceDryRun: boolean;  // true = silent placeholder (no ElevenLabs key)
  clipPaths: string[];
  /** "cat" when the orange-cat scene was used, else "product". */
  style: "product" | "cat";
  scenePath?: string;
}

/** Used when the cat scene can't be made: the Sonnet shot was written for the cat. */
const PLAIN_KLING_SHOT =
  "Slow, smooth camera push-in on the product, centered and fully in frame. It turns gently while a soft light sweep glides across its surface with subtle glints. Faint bokeh in the background. The product keeps exactly the same shape, color, logo and printed text. No hands, no people, no new objects.";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${code}: ${err.slice(-400)}`))));
  });
}

async function mediaSeconds(path: string): Promise<number> {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  const sec = Number.parseFloat(out.trim());
  if (!Number.isFinite(sec)) throw new Error(`ffprobe: no duration for ${path}`);
  return sec;
}

/** Join clips with short crossfades (clips share size/fps: same source photo). */
async function crossfade(clips: string[], out: string): Promise<void> {
  if (clips.length === 1) {
    await run("ffmpeg", ["-v", "error", "-y", "-i", clips[0]!, "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out]);
    return;
  }
  const durs = await Promise.all(clips.map(mediaSeconds));
  const parts: string[] = [];
  let prev = "[0:v]";
  let offset = 0;
  for (let i = 1; i < clips.length; i++) {
    offset += durs[i - 1]! - XFADE_SEC;
    const label = i === clips.length - 1 ? "[v]" : `[x${i}]`;
    parts.push(`${prev}[${i}:v]xfade=transition=fade:duration=${XFADE_SEC}:offset=${offset.toFixed(3)}${label}`);
    prev = label;
  }
  await run("ffmpeg", [
    "-v", "error", "-y",
    ...clips.flatMap((c) => ["-i", c]),
    "-filter_complex", parts.join(";"),
    "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p",
    out,
  ]);
}

/**
 * Fit `video` to the voice (boomerang-loop if short), place it on a
 * 1080x1920 canvas over a blurred fill, and mux the voice. Ends 0.6 s after the voice.
 */
async function finalize(video: string, voice: string, voiceSec: number, out: string): Promise<void> {
  const vidSec = await mediaSeconds(video);
  const targetSec = voiceSec + 0.6;
  const fit =
    vidSec >= targetSec
      ? "[0:v]null[src]"
      : `[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,` +
        `loop=loop=${Math.ceil(targetSec / (vidSec * 2))}:size=32767:start=0,setpts=N/FRAME_RATE/TB[src]`;
  // Footage that is already ~9:16 (cat scenes) fills the frame; square
  // Shopee footage sits on a blurred, zoomed copy of itself.
  const [w, h] = (
    await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video])
  )
    .trim()
    .split(",")
    .map(Number);
  const tall = w! > 0 && h! > 0 && w! / h! < 0.62;
  const canvas = tall
    ? "[src]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,format=yuv420p[v]"
    : "[src]split[bg][fg];" +
    "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.06[bgb];" +
    "[fg]scale=1080:-2:flags=lanczos[fgs];" +
    "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]";
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-i", video,
    "-i", voice,
    "-filter_complex", `${fit};${canvas};[1:a]apad=pad_dur=0.6[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", targetSec.toFixed(2),
    "-c:v", "libx264", "-crf", "18", "-preset", "medium",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    out,
  ]);
}

export async function makeVoicedProductVideo(productId: number): Promise<VoicedVideoResult> {
  const provider = videoProvider();
  if (!provider) throw new Error("no video provider configured (set FAL_KEY or WANGP_URL)");
  const content = await writeVideoContent(productId, { provider, style: env.VIDEO_STYLE });
  log.info({ productId, voiceover: content.voiceover, variantId: content.variantId }, "content ready");

  const voice = await generateVoice({
    text: content.voiceover,
    fileName: `video-${productId}-${Date.now()}`,
    allowLiveInDryRun: true,
    stability: 0.45,
    style: 0.25,
    task: "voice_gen.video_voiceover",
  });
  const voiceSec = await mediaSeconds(voice.filePath);
  if (voice.dryRun) log.warn({ productId }, "ElevenLabs not configured — using a silent placeholder voice");

  const clipPaths: string[] = [];
  let style: VoicedVideoResult["style"] = "product";
  let scenePath: string | undefined;
  if (provider === "kling") {
    const [p] = await db
      .select({ image: schema.products.primaryImage })
      .from(schema.products)
      .where(eq(schema.products.id, productId))
      .limit(1);
    if (!p?.image) throw new Error(`product ${productId} has no image`);
    // One continuous 10 s shot; the script is written to fit inside it.
    const seconds = voiceSec + 0.6 <= 5 ? 5 : 10;
    let imageUrl = p.image;
    let prompt = content.shots[0]!;
    let negativePrompt: string | undefined;
    if (content.cat) {
      try {
        const scene = await makeCatScene({ productId, imageUrl: p.image, ...content.cat });
        imageUrl = scene.url;
        scenePath = scene.path;
        style = "cat";
        negativePrompt =
          "changed product, distorted product, garbled text, extra cats, two cats, human hands, people, cat touching the product, blur, low quality, watermark";
      } catch (err) {
        // e.g. the image model's content checker refused: fall back to the plain photo.
        log.warn({ productId, err: err instanceof Error ? err.message : String(err) }, "cat scene failed — plain product video");
        prompt = PLAIN_KLING_SHOT;
      }
    }
    log.info({ productId, provider, seconds, style }, "generating Kling clip");
    const clip = await generateKlingClip({ productId, imageUrl, prompt, seconds, negativePrompt });
    clipPaths.push(clip.path);
  } else {
    // Split the voice length across the shots (each clip ≤5 s on a 3060).
    const perClip = Math.min(MAX_CLIP_SEC, Math.max(3, Math.ceil((voiceSec + 0.6) / content.shots.length + XFADE_SEC)));
    for (const [i, prompt] of content.shots.entries()) {
      log.info({ productId, provider, shot: i + 1, of: content.shots.length, seconds: perClip }, "generating shot");
      const clip = await generateProductVideo({ productId, style: "product", prompt, seconds: perClip });
      clipPaths.push(clip.path);
    }
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = Date.now();
  const joined = join(OUTPUT_DIR, `product-${productId}-shots-${stamp}.mp4`);
  await crossfade(clipPaths, joined);
  const out = join(OUTPUT_DIR, `product-${productId}-video-${stamp}-1080x1920.mp4`);
  await finalize(joined, voice.filePath, voiceSec, out);
  log.info({ productId, out, voiceSec }, "voiced product video ready");

  return { provider, path: out, content, voicePath: voice.filePath, voiceSec, voiceDryRun: voice.dryRun, clipPaths, style, scenePath };
}
