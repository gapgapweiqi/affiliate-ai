import { BarChart } from "@/components/charts";
import { Badge, Card, PageHeader, Table, Td, statusColor, truncate } from "@/components/ui";
import { dateTime, num, pct } from "@/lib/format";
import { getPostStatusCounts, getRecentPosts, getVariantStatsByAngle } from "@/lib/queries";

export default async function ContentPage() {
  const [angles, posts, statuses] = await Promise.all([
    getVariantStatsByAngle(),
    getRecentPosts(30),
    getPostStatusCounts(),
  ]);
  const chartData = angles.map((a) => ({ name: `${a.channel}/${a.angle}`, approved: a.approved, rejected: a.total - a.approved }));

  return (
    <>
      <PageHeader title="คอนเทนต์" subtitle="Content Performance · ข้อความที่ Claude สร้างและผลการโพสต์" />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="ผ่าน / ไม่ผ่าน Quality Gate ตามมุมการเขียน" subtitle="ช่องทาง/angle">
          <BarChart
            data={chartData}
            x="name"
            stacked
            series={[
              { key: "approved", label: "ผ่าน" },
              { key: "rejected", label: "ไม่ผ่าน" },
            ]}
          />
        </Card>
        <Card title="ประสิทธิภาพตาม angle" subtitle="CTR = คลิก ÷ ครั้งที่แสดง (จาก bandit)">
          <Table head={["ช่องทาง", "Angle", "สร้าง", "ผ่าน", "แสดง", "คลิก", "CTR"]} empty={angles.length === 0}>
            {angles.map((a) => (
              <tr key={`${a.channel}-${a.angle}`}>
                <Td>{a.channel}</Td>
                <Td className="font-medium">{a.angle}</Td>
                <Td>{num(a.total)}</Td>
                <Td>{pct(a.total ? a.approved / a.total : 0, 0)}</Td>
                <Td>{num(a.shown)}</Td>
                <Td>{num(a.clicked)}</Td>
                <Td>{a.shown ? pct(a.clicked / a.shown) : "–"}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="สถานะโพสต์" className="mt-6">
        <div className="flex flex-wrap gap-2">
          {statuses.length === 0 && <span className="text-sm text-slate-500">ยังไม่มีโพสต์</span>}
          {statuses.map((s) => (
            <span key={`${s.channel}-${s.status}-${s.dryRun}`} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <span className="text-slate-500">{s.channel}</span> <Badge color={statusColor(s.status)}>{s.status}</Badge>
              {s.dryRun && <> <Badge>dry-run</Badge></>} <span className="ml-1 font-semibold">{num(s.n)}</span>
            </span>
          ))}
        </div>
      </Card>

      <Card title="โพสต์ล่าสุด" className="mt-6">
        <Table head={["", "สินค้า / Caption", "ช่องทาง", "สถานะ", "Impr.", "คลิก", "เวลา", ""]} empty={posts.length === 0}>
          {posts.map((p) => (
            <tr key={p.id}>
              <Td>
                {p.imageUrl ? (
                  // biome-ignore lint: remote Shopee image
                  <img src={p.imageUrl} alt="" className="h-10 w-10 rounded object-cover" />
                ) : (
                  <div className="h-10 w-10 rounded bg-slate-100" />
                )}
              </Td>
              <Td className="max-w-md">
                <p className="font-medium">{truncate(p.productName, 60)}</p>
                <p className="text-xs text-slate-500">{truncate(p.caption, 140) || p.failureReason}</p>
              </Td>
              <Td>{p.channel}</Td>
              <Td>
                <Badge color={statusColor(p.status)}>{p.status}</Badge>
                {p.dryRun && <div className="mt-1"><Badge>dry-run</Badge></div>}
              </Td>
              <Td>{p.impressions == null ? "–" : num(p.impressions)}</Td>
              <Td>{p.clicks == null ? "–" : num(p.clicks)}</Td>
              <Td className="whitespace-nowrap text-xs text-slate-500">{dateTime(p.createdAt)}</Td>
              <Td>
                {p.url && !p.dryRun && (
                  <a href={p.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">
                    เปิด ↗
                  </a>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
