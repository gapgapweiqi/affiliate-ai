import { BarChart } from "@/components/charts";
import { Badge, Card, PageHeader, Table, Td, statusColor, truncate } from "@/components/ui";
import { ago, dateTime, num, usd } from "@/lib/format";
import { getLastScrape, getLlmSpendByTask, getScraperRuns, getSpendSeries, getTableCounts } from "@/lib/queries";

/** Which subsystems have credentials — mirrors `can` in src/lib/env.ts. Never shows values. */
function capabilities() {
  const has = (...keys: string[]) => keys.every((k) => Boolean(process.env[k]));
  const flag = (k: string) => process.env[k] === "true" || process.env[k] === "1";
  return [
    { name: "Claude", ok: has("ANTHROPIC_API_KEY") },
    { name: "Apify (Shopee)", ok: has("APIFY_TOKEN") },
    { name: "Shopee Open API", ok: has("SHOPEE_API_KEY", "SHOPEE_API_SECRET") },
    { name: "Facebook post", ok: has("META_PAGE_ACCESS_TOKEN") && flag("FEATURE_META_AUTO_POST") },
    { name: "Instagram", ok: has("META_INSTAGRAM_BUSINESS_ID") },
    { name: "TikTok post", ok: has("TIKTOK_ACCESS_TOKEN") && flag("FEATURE_TIKTOK_AUTO_POST") },
    { name: "Cloudflare deploy", ok: has("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID") },
    { name: "Email alerts", ok: has("RESEND_API_KEY", "OPERATOR_EMAIL") },
    { name: "Dry run", ok: flag("DEBUG_DRY_RUN") },
  ];
}

export default async function SystemPage() {
  const [runs, spend, byTask, counts, last] = await Promise.all([
    getScraperRuns(20),
    getSpendSeries(14),
    getLlmSpendByTask(7),
    getTableCounts(),
    getLastScrape(),
  ]);
  const llmBudget = Number(process.env.DAILY_LLM_BUDGET_USD ?? 10);
  const apifyBudget = Number(process.env.APIFY_DAILY_BUDGET_USD ?? 2);
  const today = spend.at(-1);

  return (
    <>
      <PageHeader title="สถานะระบบ" subtitle={`System Health · ดึงสินค้าล่าสุด ${ago(last?.lastScrapedAt)}`} />

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="การเชื่อมต่อ" subtitle="ตั้งค่า key แล้วหรือยัง (ไม่แสดงค่า)">
          <ul className="grid grid-cols-1 gap-2 text-sm">
            {capabilities().map((c) => (
              <li key={c.name} className="flex items-center justify-between">
                <span>{c.name}</span>
                <Badge color={c.ok ? "green" : "gray"}>{c.ok ? "พร้อม" : "ยังไม่ตั้ง"}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="งบวันนี้" subtitle="เทียบกับเพดานใน .env">
          {[
            { label: "Claude", used: today?.llm ?? 0, cap: llmBudget },
            { label: "Apify", used: today?.scrape ?? 0, cap: apifyBudget },
          ].map((b) => {
            const ratio = b.cap ? Math.min(1, b.used / b.cap) : 0;
            return (
              <div key={b.label} className="mb-4">
                <div className="flex justify-between text-sm">
                  <span>{b.label}</span>
                  <span className="tabular-nums text-slate-600">${b.used.toFixed(3)} / ${b.cap.toFixed(2)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-slate-100">
                  <div
                    className={`h-2 rounded-full ${ratio > 0.9 ? "bg-rose-500" : ratio > 0.6 ? "bg-amber-500" : "bg-blue-600"}`}
                    style={{ width: `${ratio * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </Card>

        <Card title="ข้อมูลในฐานข้อมูล">
          <ul className="space-y-1 text-sm">
            {counts.map((c) => (
              <li key={c.name} className="flex justify-between">
                <span className="font-mono text-xs text-slate-600">{c.name}</span>
                <span className="tabular-nums">{num(c.n)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="ค่าใช้จ่ายรายวัน (USD)" subtitle="14 วันล่าสุด" className="mt-6">
        <BarChart
          data={spend as unknown as Record<string, unknown>[]}
          x="day"
          stacked
          valuePrefix="$"
          series={[
            { key: "llm", label: "Claude" },
            { key: "scrape", label: "Apify" },
          ]}
        />
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="การดึงสินค้าล่าสุด">
          <Table head={["เวลา", "Target", "สถานะ", "สำเร็จ", "ค่าใช้จ่าย", "ใช้เวลา"]} empty={runs.length === 0}>
            {runs.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap text-xs text-slate-500">{dateTime(r.startedAt)}</Td>
                <Td>
                  {truncate(r.target, 30)}
                  {r.errorMsg && <p className="text-xs text-rose-600">{truncate(r.errorMsg, 80)}</p>}
                </Td>
                <Td><Badge color={statusColor(r.status)}>{r.status}</Badge></Td>
                <Td>{num(r.succeeded)}/{num(r.attempted)}</Td>
                <Td>{usd(r.costMicros, 3)}</Td>
                <Td>{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : "–"}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Claude ตามงาน" subtitle="7 วันล่าสุด">
          <Table head={["งาน", "รุ่น", "เรียก", "ล้มเหลว", "ค่าใช้จ่าย", "เฉลี่ย"]} empty={byTask.length === 0}>
            {byTask.map((t) => (
              <tr key={`${t.task}-${t.model}`}>
                <Td className="font-mono text-xs">{t.task}</Td>
                <Td className="text-xs">{t.model}</Td>
                <Td>{num(t.calls)}</Td>
                <Td className={t.failures ? "text-rose-600" : ""}>{num(t.failures)}</Td>
                <Td>{usd(t.costMicros, 3)}</Td>
                <Td>{(t.avgMs / 1000).toFixed(1)}s</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
