import { BarChart } from "@/components/charts";
import { Badge, Card, Kpi, PageHeader, Table, Td, statusColor, truncate } from "@/components/ui";
import { baht, dateTime, num, NICHE_LABEL, pct } from "@/lib/format";
import { getChannelPerformance, getConversionTotals, getRecentConversions, getTopProductsByClicks } from "@/lib/queries";

export default async function RevenuePage() {
  const [channels, top, conv, sales] = await Promise.all([
    getChannelPerformance(30),
    getTopProductsByClicks(30, 15),
    getConversionTotals(30),
    getRecentConversions(20),
  ]);
  const shopeeApi = Boolean(process.env.SHOPEE_API_KEY && process.env.SHOPEE_API_SECRET);
  const totalClicks = channels.reduce((s, c) => s + c.clicks, 0);
  const totalRevenue = channels.reduce((s, c) => s + Number(c.revenueSatang), 0);
  const totalConv = channels.reduce((s, c) => s + c.conversions, 0);

  return (
    <>
      <PageHeader title="รายได้" subtitle="Revenue Analytics · 30 วันล่าสุด" />

      {!shopeeApi && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ยอดขายและค่าคอมจริงจะมาจาก Shopee Open API (ตอนนี้รออนุมัติ) — ใส่ SHOPEE_API_KEY / SHOPEE_API_SECRET แล้วระบบจะดึงรายงานทุก 6 ชม.
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="ออเดอร์จาก Shopee (30 วัน)" value={num(conv?.orders)} hint={`${num(conv?.items)} ชิ้น`} />
        <Kpi label="ค่าคอม (30 วัน)" value={baht(conv?.commissionSatang)} />
        <Kpi label="ยอดขายที่เราพาไป" value={baht(conv?.salesSatang)} />
        <Kpi
          label="ระบุโพสต์ได้"
          value={conv?.items ? pct((conv.attributedItems ?? 0) / conv.items, 0) : "–"}
          hint="ชิ้นที่ subId ชี้กลับไปหาโพสต์ของเรา"
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="คลิกทั้งหมด" value={num(totalClicks)} />
        <Kpi label="Conversion" value={num(totalConv)} />
        <Kpi label="รายได้ (ค่าคอม)" value={baht(totalRevenue)} />
        <Kpi label="รายได้ต่อคลิก" value={totalClicks ? baht(totalRevenue / totalClicks) : "–"} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="คลิกตามช่องทาง" subtitle="ไม่รวมบอท · unique = คลิกแรกต่อผู้ใช้">
          <BarChart
            data={channels as unknown as Record<string, unknown>[]}
            x="channel"
            series={[
              { key: "clicks", label: "คลิกทั้งหมด" },
              { key: "uniqueClicks", label: "Unique" },
            ]}
          />
        </Card>
        <Card title="สรุปตามช่องทาง">
          <Table head={["ช่องทาง", "ลิงก์", "คลิก", "Conv.", "CVR", "รายได้"]} empty={channels.length === 0}>
            {channels.map((c) => (
              <tr key={c.channel}>
                <Td className="font-medium">{c.channel}</Td>
                <Td>{num(c.links)}</Td>
                <Td>{num(c.clicks)}</Td>
                <Td>{num(c.conversions)}</Td>
                <Td>{c.clicks ? pct(c.conversions / c.clicks) : "–"}</Td>
                <Td>{baht(c.revenueSatang)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="สินค้าที่มีคนคลิกมากที่สุด" className="mt-6">
        <Table head={["#", "สินค้า", "หมวด", "ราคา", "คลิก", "รายได้"]} empty={top.length === 0}>
          {top.map((p, i) => (
            <tr key={p.id}>
              <Td className="text-slate-400">{i + 1}</Td>
              <Td>{truncate(p.name, 80)}</Td>
              <Td>{p.niche ? NICHE_LABEL[p.niche] ?? p.niche : "–"}</Td>
              <Td>{baht(p.currentPrice)}</Td>
              <Td className="font-semibold">{num(p.clicks)}</Td>
              <Td>{baht(p.revenueSatang)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="ยอดขายล่าสุดจาก Shopee" subtitle="จาก conversion report · อัปเดตทุก 6 ชม." className="mt-6">
        <Table head={["เวลา", "สินค้า", "ชิ้น", "สถานะ", "ค่าคอม", "ช่องทาง", "โพสต์"]} empty={sales.length === 0}>
          {sales.map((c) => (
            <tr key={c.id}>
              <Td className="whitespace-nowrap text-xs text-slate-500">{dateTime(c.purchasedAt)}</Td>
              <Td>{truncate(c.itemName, 50)}</Td>
              <Td>{c.qty ?? "–"}</Td>
              <Td><Badge color={statusColor((c.orderStatus ?? "").toLowerCase())}>{c.orderStatus ?? "–"}</Badge></Td>
              <Td className="whitespace-nowrap">{baht(c.commissionSatang)}</Td>
              <Td>{c.channel ?? "–"}</Td>
              <Td>
                {c.postUrl ? (
                  <a href={c.postUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">เปิดโพสต์</a>
                ) : (
                  "–"
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
