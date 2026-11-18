import { BarChart } from "@/components/charts";
import { Card, Kpi, PageHeader, Table, Td, truncate } from "@/components/ui";
import { baht, num, NICHE_LABEL, pct } from "@/lib/format";
import { getChannelPerformance, getTopProductsByClicks } from "@/lib/queries";

export default async function RevenuePage() {
  const [channels, top] = await Promise.all([getChannelPerformance(30), getTopProductsByClicks(30, 15)]);
  const totalClicks = channels.reduce((s, c) => s + c.clicks, 0);
  const totalRevenue = channels.reduce((s, c) => s + Number(c.revenueSatang), 0);
  const totalConv = channels.reduce((s, c) => s + c.conversions, 0);

  return (
    <>
      <PageHeader title="รายได้" subtitle="Revenue Analytics · 30 วันล่าสุด" />

      <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        ยอดขายและค่าคอมจริงจะมาจาก Shopee Open API (ตอนนี้รออนุมัติ) — หน้านี้จึงแสดงคลิกเป็นหลักจนกว่าจะเชื่อมต่อได้
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
    </>
  );
}
