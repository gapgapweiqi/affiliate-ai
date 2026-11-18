/**
 * `bun run src/scripts/rescore-products.ts`
 *
 * Recompute products.final_score for every active product and print the
 * top 10. The scheduler also does this after each scrape and nightly.
 */

import { sql } from "drizzle-orm";
import { closeDb, db } from "../lib/db.ts";
import { rescoreProducts } from "../brain/product-scorer.ts";

async function main() {
  const { scored } = await rescoreProducts();
  console.log(`Scored ${scored} products\n`);

  const top = await db.execute<{ id: number; name: string; final_score: number; [k: string]: unknown }>(sql`
    SELECT id, LEFT(name, 60) AS name, final_score, demand_score, profitability_score,
           sold_count, rating, rating_count, ROUND((discount_percent * 100)::numeric) AS disc
    FROM products
    WHERE final_score IS NOT NULL AND is_active AND NOT flag_blacklisted
    ORDER BY final_score DESC
    LIMIT 10
  `);
  console.table(top);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
