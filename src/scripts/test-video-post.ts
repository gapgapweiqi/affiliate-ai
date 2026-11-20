/**
 * `bun run src/scripts/test-video-post.ts [productId] [seconds] [product|presenter|voiced]`
 *
 * End-to-end: product → video on the host GPU (WanGP) → Facebook video post.
 * Without a productId, picks the highest final_score product that has an
 * approved Facebook variant.
 *
 *   product   — animate the Shopee photo (silent)
 *   presenter — presenter holding the product (silent)
 *   voiced    — Sonnet script + shots + caption → ElevenLabs voice → product clips → muxed,
 *               posted with its own gated caption
 *               (seconds is ignored; the voice sets the length)
 *
 * Honors DEBUG_DRY_RUN like every publisher — pass `-e DEBUG_DRY_RUN=false`
 * to docker compose run for a real post.
 */

import { sql } from "drizzle-orm";
import { makeVoicedProductVideo } from "../content/video-pipeline.ts";
import { generateProductVideo } from "../content/wangp-client.ts";
import { closeDb, db } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { publishToFacebook } from "../publisher/facebook.ts";

async function pickProduct(): Promise<number> {
  const [row] = await db.execute<{ id: number; [k: string]: unknown }>(sql`
    SELECT p.id FROM products p
    WHERE p.is_active AND NOT p.flag_blacklisted AND p.primary_image LIKE 'https://%'
      AND EXISTS (SELECT 1 FROM content_variants cv
                  WHERE cv.product_id = p.id AND cv.channel = 'facebook'
                    AND cv.gate_approved AND cv.is_active)
    ORDER BY COALESCE(p.final_score, 0) DESC
    LIMIT 1
  `);
  if (!row) throw new Error("no product with an approved facebook variant");
  return row.id;
}

async function main() {
  const productId = Number(process.argv[2]) || (await pickProduct());
  const seconds = Number(process.argv[3]) || undefined;
  const mode = (["product", "presenter", "voiced"] as const).find((m) => m === process.argv[4]) ?? "product";
  console.log(`product ${productId} · ${mode} · dry-run=${env.DEBUG_DRY_RUN}`);

  const t0 = Date.now();
  let videoPath: string;
  let variantId: number | undefined;
  if (mode === "voiced") {
    const v = await makeVoicedProductVideo(productId);
    console.log(`provider: ${v.provider}`);
    console.log(`voiceover (${v.voiceSec.toFixed(1)}s${v.voiceDryRun ? ", SILENT placeholder" : ""}): ${v.content.voiceover}`);
    v.content.shots.forEach((s, i) => console.log(`shot ${i + 1}: ${s}`));
    console.log(`caption (variant ${v.content.variantId ?? "REJECTED"}):\n${v.content.caption}`);
    console.log(`video: ${v.path} (total ${((Date.now() - t0) / 1000).toFixed(0)}s, LLM $${v.content.costUsd.toFixed(4)})`);
    if (!v.content.variantId) {
      console.log(`Quality Gate rejected the caption — not posting: ${v.content.gateIssues.join("; ")}`);
      return;
    }
    videoPath = v.path;
    variantId = v.content.variantId;
  } else {
    const v = await generateProductVideo({ productId, seconds, style: mode });
    videoPath = v.path;
    console.log(`video: ${videoPath} (total ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  const res = await publishToFacebook({ productId, videoPath, variantId });
  console.log(JSON.stringify(res, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
