/**
 * `bun run src/scripts/run-daily-captions.ts [count]`
 *
 * Run the daily-captions job now (the scheduler runs it at 07:30 BKK).
 */

import { runDailyCaptions } from "../brain/daily-captions.ts";
import { closeDb } from "../lib/db.ts";
import { env } from "../lib/env.ts";

const count = Number(process.argv[2]) || env.DAILY_CAPTION_PRODUCTS;
runDailyCaptions({ count })
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
