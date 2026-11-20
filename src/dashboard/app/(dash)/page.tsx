import Link from "next/link";
import { LineChart } from "@/components/charts";
import { Badge, Card, Kpi, PageHeader, statusColor, truncate } from "@/components/ui";
import { ago, baht, num, usd } from "@/lib/format";
import { getDailySeries, getLastScrape, getOpenAlerts, getRecentPosts, getSnapshotKpis } from "@/lib/queries";

export default async function SnapshotPage() {
  const [k, series, alerts, posts, last] = await Promise.all([
    getSnapshotKpis(),
    getDailySeries(14),
    getOpenAlerts(),
    getRecentPosts(5),
    getLastScrape(),
  ]);
  if (!k) return null;

  return (
    <>
      <PageHeader title="ภาพรวมวันนี้" subtitle={`ดึงสินค้าล่าสุด ${ago(last?.lastScrapedAt)} · เวลาไทย`} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="คลิก /go/ วันนี้" value={num(k.clicksToday)} delta={{ now: k.clicksToday, prev: k.clicksYesterday }} hint="เฉพาะลิงก์ผ่านเว็บของเรา" />
        <Kpi label="คลิกจาก Facebook (7 วัน)" value={num(k.fbClicks7d)} hint="Facebook Insights · ใช้ได้แม้ลิงก์ไป Shopee ตรง" />
        <Kpi label="สินค้าใหม่วันนี้" value={num(k.newProductsToday)} delta={{ now: k.newProductsToday, prev: k.newProductsYesterday }} />
        <Kpi label="โพสต์จริงวันนี้" value={num(k.postsToday)} delta={{ now: k.postsToday, prev: k.postsYesterday }} />
        <Kpi
          label="ค่าใช้จ่ายวันนี้"
          value={usd(Number(k.llmMicrosToday) + Number(k.scrapeMicrosToday))}
          hint={`Claude ${usd(k.llmMicrosToday)} · Apify ${usd(k.scrapeMicrosToday)}`}
        />
        <Kpi label="สินค้าที่ใช้งาน" value={num(k.activeProducts)} />
        <Kpi
          label="ค่าคอม 30 วัน"
          value={baht(k.revenueSatang30d)}
          hint={process.env.SHOPEE_API_KEY ? "จากรายงานยอดขาย Shopee" : "รอ Shopee Open API"}
        />
        <Kpi label="แจ้งเตือนค้าง" value={num(k.openAlerts)} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="14 วันล่าสุด" subtitle="แยกกราฟละตัวชี้วัด เพราะสเกลต่างกันมาก" className="xl:col-span-2">
          <div className="grid gap-4 md:grid-cols-3">
            {[
              { key: "clicks", label: "คลิก (ไม่รวมบอท)", slot: 0 },
              { key: "newProducts", label: "สินค้าใหม่", slot: 1 },
              { key: "posts", label: "โพสต์จริง", slot: 2 },
            ].map((m) => (
              <div key={m.key}>
                <div className="mb-1 text-xs font-medium text-slate-600">{m.label}</div>
                <LineChart
                  data={series as unknown as Record<string, unknown>[]}
                  x="day"
                  height={180}
                  series={[{ key: m.key, label: m.label, slot: m.slot }]}
                />
              </div>
            ))}
          </div>
        </Card>

        <Card title="แจ้งเตือนที่ยังไม่ปิด">
          {alerts.length === 0 ? (
            <p className="text-sm text-slate-500">ไม่มีแจ้งเตือนค้าง 🎉</p>
          ) : (
            <ul className="space-y-3">
              {alerts.slice(0, 6).map((a) => (
                <li key={a.id} className="text-sm">
                  <Badge color={statusColor(a.severity)}>{a.severity}</Badge>{" "}
                  <span className="font-medium">{a.title}</span>
                  <span className="block text-xs text-slate-400">{ago(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/actions" className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline">
            ไปที่สิ่งที่ต้องทำ →
          </Link>
        </Card>
      </div>

      <Card title="โพสต์ล่าสุด" className="mt-6">
        {posts.length === 0 ? (
          <p className="text-sm text-slate-500">ยังไม่มีโพสต์</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {posts.map((p) => (
              <li key={p.id} className="flex items-start gap-3 py-3 text-sm">
                {p.imageUrl ? (
                  // biome-ignore lint: remote Shopee image
                  <img src={p.imageUrl} alt="" className="h-12 w-12 rounded-md object-cover" />
                ) : (
                  <div className="h-12 w-12 rounded-md bg-slate-100" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-800">{truncate(p.productName, 70)}</p>
                  <p className="text-xs text-slate-500">{truncate(p.caption, 120)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge color={statusColor(p.status)}>{p.status}</Badge>
                  {p.dryRun && <Badge>dry-run</Badge>}
                  <span className="text-xs text-slate-400">{p.channel} · {ago(p.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
