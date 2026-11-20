/**
 * Shopee conversion report → affiliate_conversions.
 *
 * Pulls sold items from the Open Affiliate API (`conversionReport`) for the
 * last REPORT_DAYS days, upserts them (order status and commission change
 * as orders complete or get cancelled), maps each sale back to our
 * affiliate link through the subIds on the short link (utmContent), then
 * recomputes per-caption revenue so the dashboard's revenue page and the
 * variant picker see real commission.
 *
 * ⚠ Field names follow Shopee's docs and open-source wrappers; verify them
 * against a live response once the Open API is approved
 * (`bun run src/scripts/shopee-report.ts --raw` prints one page as-is).
 */

import { sql } from "drizzle-orm";
import { db, schema } from "../lib/db.ts";
import { child } from "../lib/logger.ts";
import { shopeeApiConfigured, shopeeGraphQL } from "./shopee-api.ts";

const log = child("shopee.report");
const REPORT_DAYS = 7;
const PAGE_SIZE = 200;

interface ReportItem {
  itemId?: string | number;
  itemName?: string;
  itemPrice?: string | number;
  actualAmount?: string | number;
  qty?: number;
  itemTotalCommission?: string | number;
}
interface ReportNode {
  purchaseTime?: number;
  clickTime?: number;
  conversionId?: string | number;
  totalCommission?: string | number;
  utmContent?: string;
  orders?: Array<{ orderId?: string | number; orderStatus?: string; items?: ReportItem[] }>;
}
interface ReportPage {
  conversionReport: { nodes: ReportNode[]; pageInfo: { hasNextPage: boolean; scrollId?: string } };
}

export interface ShopeeReportResult {
  pages: number;
  items: number;
  attributed: number;
  commissionSatang: number;
  skipped?: string;
}

const satang = (v: unknown): number => {
  const n = Number.parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const tsOrNull = (unix?: number) => (unix ? new Date(unix * 1000) : null);

function reportQuery(start: number, end: number, scrollId: string): string {
  return `{ conversionReport(purchaseTimeStart: ${start}, purchaseTimeEnd: ${end}, limit: ${PAGE_SIZE}, scrollId: ${JSON.stringify(scrollId)}) {
    nodes { purchaseTime clickTime conversionId totalCommission utmContent
      orders { orderId orderStatus items { itemId itemName itemPrice actualAmount qty itemTotalCommission } } }
    pageInfo { hasNextPage scrollId } } }`;
}

/** One raw page, for checking field names against the live API. */
export async function fetchRawReportPage(days = REPORT_DAYS): Promise<unknown> {
  const end = Math.floor(Date.now() / 1000);
  return shopeeGraphQL<ReportPage>(reportQuery(end - days * 86400, end, ""));
}

export async function runShopeeReport(opts: { days?: number } = {}): Promise<ShopeeReportResult> {
  const result: ShopeeReportResult = { pages: 0, items: 0, attributed: 0, commissionSatang: 0 };
  if (!shopeeApiConfigured()) return { ...result, skipped: "SHOPEE_API_KEY/SECRET not set" };

  const end = Math.floor(Date.now() / 1000);
  const start = end - (opts.days ?? REPORT_DAYS) * 86400;
  let scrollId = "";

  for (let page = 0; page < 100; page++) {
    const data = await shopeeGraphQL<ReportPage>(reportQuery(start, end, scrollId));
    const { nodes, pageInfo } = data.conversionReport;
    result.pages++;

    for (const node of nodes ?? []) {
      // utmContent = our subIds joined by "-": channel, shortId, campaign, variant
      const tokens = (node.utmContent ?? "").split("-").filter(Boolean);
      const [link] = tokens.length
        ? await db.execute<{ id: number; short_id: string; product_id: number | null; content_variant_id: number | null; [k: string]: unknown }>(sql`
            SELECT id, short_id, product_id, content_variant_id FROM affiliate_links
            WHERE short_id IN (${sql.join(tokens.map((t) => sql`${t}`), sql`, `)}) LIMIT 1`)
        : [];

      for (const order of node.orders ?? []) {
        for (const item of order.items ?? []) {
          const commission = satang(item.itemTotalCommission);
          const amount = item.actualAmount != null ? satang(item.actualAmount) : satang(item.itemPrice) * (item.qty ?? 1);
          await db
            .insert(schema.affiliateConversions)
            .values({
              platform: "shopee",
              conversionId: String(node.conversionId ?? ""),
              orderId: String(order.orderId ?? ""),
              itemId: String(item.itemId ?? ""),
              itemName: item.itemName ?? null,
              qty: item.qty ?? null,
              orderStatus: order.orderStatus ?? null,
              commissionSatang: commission,
              amountSatang: amount,
              utmContent: node.utmContent?.slice(0, 255) ?? null,
              shortId: link?.short_id ?? null,
              affiliateLinkId: link?.id ?? null,
              productId: link?.product_id ?? null,
              contentVariantId: link?.content_variant_id ?? null,
              purchasedAt: tsOrNull(node.purchaseTime),
              clickedAt: tsOrNull(node.clickTime),
              raw: { node: { ...node, orders: undefined }, order: { ...order, items: undefined }, item },
            })
            .onConflictDoUpdate({
              target: [
                schema.affiliateConversions.platform,
                schema.affiliateConversions.conversionId,
                schema.affiliateConversions.orderId,
                schema.affiliateConversions.itemId,
              ],
              set: { orderStatus: order.orderStatus ?? null, commissionSatang: commission, amountSatang: amount, capturedAt: new Date() },
            });
          result.items++;
          result.commissionSatang += commission;
          if (link) result.attributed++;
        }
      }
    }

    if (!pageInfo?.hasNextPage || !pageInfo.scrollId) break;
    scrollId = pageInfo.scrollId;
  }

  // Per-caption revenue = all non-cancelled commission attributed to it.
  // Recomputed (not incremented) so re-pulling the same days never double counts.
  await db.execute(sql`
    UPDATE content_variants cv SET
      revenue_satang = s.commission,
      times_converted = s.orders
    FROM (
      SELECT content_variant_id, sum(commission_satang)::bigint AS commission, count(DISTINCT order_id)::int AS orders
      FROM affiliate_conversions
      WHERE content_variant_id IS NOT NULL
        AND coalesce(order_status, '') !~* '(cancel|invalid|fail)'
      GROUP BY content_variant_id
    ) s
    WHERE cv.id = s.content_variant_id
  `);

  log.info(result, "shopee conversion report synced");
  return result;
}
