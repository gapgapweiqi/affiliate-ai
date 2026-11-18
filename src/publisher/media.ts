/**
 * Default media for social posts: when the caller doesn't supply an image
 * or video, fall back to the product's primary image scraped from Shopee.
 * Without this, FB posts go out as text-only and IG (media required) fails.
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";

export async function withDefaultImage<T extends { productId: number; imageUrl?: string; videoUrl?: string }>(
  opts: T,
): Promise<T> {
  if (opts.imageUrl || opts.videoUrl) return opts;
  const [row] = await db
    .select({ primaryImage: schema.products.primaryImage })
    .from(schema.products)
    .where(eq(schema.products.id, opts.productId))
    .limit(1);
  const url = row?.primaryImage;
  return url && /^https:\/\//.test(url) ? { ...opts, imageUrl: url } : opts;
}
