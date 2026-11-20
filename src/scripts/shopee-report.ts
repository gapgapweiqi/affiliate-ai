/**
 * `bun run src/scripts/shopee-report.ts [days]`        sync conversions now
 * `bun run src/scripts/shopee-report.ts --raw [days]`  print one raw API page
 *
 * --raw is for checking the conversionReport field names against the live
 * Open Affiliate API right after approval.
 */

import { fetchRawReportPage, runShopeeReport } from "../affiliate/shopee-report.ts";
import { closeDb } from "../lib/db.ts";

const raw = process.argv.includes("--raw");
const days = Number(process.argv.find((a) => /^\d+$/.test(a))) || 7;

(raw ? fetchRawReportPage(days) : runShopeeReport({ days }))
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
