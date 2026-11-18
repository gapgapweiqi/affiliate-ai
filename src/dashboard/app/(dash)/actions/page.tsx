import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Table, Td, statusColor, truncate } from "@/components/ui";
import { ago, dateTime } from "@/lib/format";
import { resolveAlert } from "../../actions";
import { getFailedPosts, getOpenAlerts, getOpportunities, getSuspiciousPrices } from "@/lib/queries";

export default async function ActionsPage() {
  const [alerts, failed, suspicious, opps] = await Promise.all([
    getOpenAlerts(),
    getFailedPosts(15),
    getSuspiciousPrices(),
    getOpportunities(5),
  ]);

  // Setup checklist — derived from which keys are present (values never shown).
  const todo = [
    !process.env.SHOPEE_API_KEY && "ใส่ SHOPEE_API_KEY / SHOPEE_API_SECRET เมื่อ Shopee อนุมัติ แล้วรัน backfill-shopee-shortlinks",
    !process.env.META_INSTAGRAM_BUSINESS_ID && "ตั้ง META_INSTAGRAM_BUSINESS_ID ถ้าจะโพสต์ Instagram",
    !process.env.RESEND_API_KEY && "ตั้ง RESEND_API_KEY + OPERATOR_EMAIL เพื่อรับรายงานรายวันทางอีเมล",
    (process.env.DEBUG_DRY_RUN === "true" || process.env.DEBUG_DRY_RUN === "1") &&
      "ยังอยู่ในโหมด DRY RUN — ปิดเมื่อพร้อมโพสต์จริง (ต้องมี Page token อายุยาวก่อน)",
  ].filter(Boolean) as string[];

  return (
    <>
      <PageHeader title="สิ่งที่ต้องทำ" subtitle="Action Center" />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={`แจ้งเตือนที่ยังไม่ปิด (${alerts.length})`}>
          {alerts.length === 0 ? (
            <Empty>ไม่มีแจ้งเตือนค้าง</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge color={statusColor(a.severity)}>{a.severity}</Badge>
                      <span className="font-medium">{a.title}</span>
                    </div>
                    {a.body && <p className="mt-1 text-xs text-slate-500">{truncate(a.body, 200)}</p>}
                    <p className="mt-1 text-xs text-slate-400">{a.code} · {ago(a.createdAt)}</p>
                  </div>
                  <form action={resolveAlert}>
                    <input type="hidden" name="id" value={a.id} />
                    <button className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50">ปิดแจ้งเตือน</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="ตั้งค่าที่ยังขาด">
          {todo.length === 0 ? (
            <Empty>ตั้งค่าครบแล้ว</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {todo.map((t) => (
                <li key={t} className="flex gap-2">
                  <span className="mt-0.5 text-slate-400">☐</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="โพสต์ที่ล้มเหลว (7 วัน)" className="mt-6">
        <Table head={["เวลา", "ช่องทาง", "สินค้า", "สาเหตุ"]} empty={failed.length === 0}>
          {failed.map((p) => (
            <tr key={p.id}>
              <Td className="whitespace-nowrap text-xs text-slate-500">{dateTime(p.createdAt)}</Td>
              <Td>{p.channel}</Td>
              <Td>{truncate(p.productName, 60)}</Td>
              <Td className="text-xs text-rose-700">{truncate(p.failureReason, 120)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="สินค้าราคาน่าสงสัย">
          <p className="text-sm text-slate-600">
            มี <span className="font-semibold">{suspicious.length}</span> รายการที่ราคาต่ำผิดปกติ
          </p>
          <Link href="/compliance" className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline">
            ตรวจและซ่อน →
          </Link>
        </Card>
        <Card title="โอกาสที่ยังไม่ได้ใช้">
          <ul className="space-y-1 text-sm">
            {opps.length === 0 && <li className="text-slate-500">ไม่มี</li>}
            {opps.map((p) => (
              <li key={p.id}>• {truncate(p.name, 70)}</li>
            ))}
          </ul>
          <Link href="/trends" className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline">
            ดูทั้งหมด →
          </Link>
        </Card>
      </div>
    </>
  );
}
