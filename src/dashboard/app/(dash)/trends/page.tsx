import { BarChart, COLORS } from "@/components/charts";
import { Badge, Card, PageHeader, Table, Td, truncate } from "@/components/ui";
import { ago, baht, num, NICHE_LABEL, pct } from "@/lib/format";
import { getNicheBreakdown, getOpportunities, getRecentPromoEvents } from "@/lib/queries";

const EVENT_LABEL: Record<string, string> = {
  price_drop: "ราคาลด",
  discount_jump: "ส่วนลดเพิ่ม",
  sold_surge: "ยอดขายพุ่ง",
  new_low: "ราคาต่ำสุดใหม่",
};

export default async function TrendsPage() {
  const [niches, promos, opps] = await Promise.all([getNicheBreakdown(), getRecentPromoEvents(25), getOpportunities(20)]);
  const nicheData = niches.map((n) => ({ ...n, label: NICHE_LABEL[n.niche] ?? "ยังไม่ระบุหมวด" }));

  return (
    <>
      <PageHeader title="เทรนด์และโอกาส" subtitle="Trends & Opportunities" />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="สินค้าตามหมวด" subtitle="จำนวนสินค้าที่ใช้งาน · คลิก 30 วัน">
          <BarChart
            data={nicheData as unknown as Record<string, unknown>[]}
            x="label"
            horizontal
            height={Math.max(180, nicheData.length * 40)}
            series={[
              { key: "products", label: "สินค้า", color: COLORS.blue },
              { key: "clicks30d", label: "คลิก 30 วัน", color: COLORS.amber },
            ]}
          />
        </Card>
        <Card title="สัญญาณโปรโมชัน" subtitle="จาก Promo Hunter (FEATURE_PROMO_HUNTER)">
          <Table head={["สินค้า", "สัญญาณ", "เปลี่ยน", "เมื่อ"]} empty={promos.length === 0}>
            {promos.map((e) => (
              <tr key={e.id}>
                <Td>{truncate(e.productName, 50)}</Td>
                <Td><Badge color="blue">{EVENT_LABEL[e.eventType] ?? e.eventType}</Badge></Td>
                <Td>{e.deltaPct == null ? "–" : `${e.deltaPct > 0 ? "+" : ""}${e.deltaPct.toFixed(0)}%`}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-500">{ago(e.detectedAt)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card
        title="โอกาสที่ยังไม่ได้ใช้"
        subtitle="ราคา > ฿50 · ลด 20–90% · rating ≥ 4.5 · ยังไม่มีโพสต์ที่ผ่าน gate"
        className="mt-6"
      >
        <Table head={["สินค้า", "หมวด", "ราคา", "ลด", "Rating", "รีวิว", "พบเมื่อ"]} empty={opps.length === 0}>
          {opps.map((p) => (
            <tr key={p.id}>
              <Td>{truncate(p.name, 70)}</Td>
              <Td>{p.niche ? NICHE_LABEL[p.niche] ?? p.niche : "–"}</Td>
              <Td className="whitespace-nowrap">
                {baht(p.currentPrice)}
                {p.originalPrice && <span className="ml-1 text-xs text-slate-400 line-through">{baht(p.originalPrice)}</span>}
              </Td>
              <Td className="font-semibold text-rose-600">{pct(p.discountPercent, 0)}</Td>
              <Td>{p.rating?.toFixed(1) ?? "–"}</Td>
              <Td>{num(p.ratingCount)}</Td>
              <Td className="whitespace-nowrap text-xs text-slate-500">{ago(p.firstSeenAt)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
