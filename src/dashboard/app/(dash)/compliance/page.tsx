import { BarChart } from "@/components/charts";
import { Badge, Card, PageHeader, Table, Td, truncate } from "@/components/ui";
import { baht, dateTime, pct } from "@/lib/format";
import { deactivateVariant, setProductBlacklist } from "../../actions";
import { getFlaggedProducts, getIssueBreakdown, getRejectedVariants, getSuspiciousPrices } from "@/lib/queries";

export default async function CompliancePage() {
  const [issues, rejected, flagged, suspicious] = await Promise.all([
    getIssueBreakdown(),
    getRejectedVariants(25),
    getFlaggedProducts(),
    getSuspiciousPrices(),
  ]);

  return (
    <>
      <PageHeader title="ความเสี่ยงและการปฏิบัติตามกฎ" subtitle="Compliance & Risk · สิ่งที่ Quality Gate กันไว้ และสินค้าที่ควรระวัง" />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="เหตุผลที่ไม่ผ่าน Quality Gate" subtitle="นับจากข้อความที่ถูกปฏิเสธทั้งหมด">
          {issues.length === 0 ? (
            <p className="text-sm text-slate-500">ยังไม่มีข้อความที่ถูกปฏิเสธ</p>
          ) : (
            <BarChart
              data={issues as unknown as Record<string, unknown>[]}
              x="kind"
              horizontal
              height={Math.max(160, issues.length * 36)}
              series={[{ key: "n", label: "ครั้ง" }]}
            />
          )}
        </Card>

        <Card title="ราคาน่าสงสัย" subtitle="ต่ำกว่า ฿20 หรือลด ≥ 90% — มักเป็นราคาล่อ ไม่ควรโปรโมต">
          <Table head={["สินค้า", "ราคา", "ลด", ""]} empty={suspicious.length === 0}>
            {suspicious.map((p) => (
              <tr key={p.id}>
                <Td>{truncate(p.name, 50)}</Td>
                <Td className="whitespace-nowrap">{baht(p.currentPrice)}</Td>
                <Td>{pct(p.discountPercent, 0)}</Td>
                <Td>
                  <form action={setProductBlacklist}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="on" value="true" />
                    <input type="hidden" name="reason" value="suspicious price (dashboard)" />
                    <button className="whitespace-nowrap rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50">
                      ซ่อนสินค้า
                    </button>
                  </form>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="ข้อความที่ไม่ผ่าน Quality Gate" className="mt-6">
        <Table head={["สินค้า", "ช่องทาง/angle", "Caption", "ปัญหา", "เวลา", ""]} empty={rejected.length === 0}>
          {rejected.map((v) => (
            <tr key={v.id}>
              <Td className="max-w-[12rem]">{truncate(v.productName, 40)}</Td>
              <Td className="whitespace-nowrap text-xs">{v.channel}/{v.angle}</Td>
              <Td className="max-w-sm text-xs text-slate-600">{truncate(v.caption, 160)}</Td>
              <Td className="max-w-sm">
                <ul className="space-y-1">
                  {(v.issues ?? []).slice(0, 3).map((i, idx) => (
                    <li key={idx} className="text-xs text-rose-700">{truncate(i, 140)}</li>
                  ))}
                </ul>
              </Td>
              <Td className="whitespace-nowrap text-xs text-slate-500">{dateTime(v.createdAt)}</Td>
              <Td>
                <form action={deactivateVariant}>
                  <input type="hidden" name="id" value={v.id} />
                  <button className="text-xs text-slate-500 hover:text-slate-800">ปิดใช้</button>
                </form>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="สินค้าที่ถูกซ่อนหรือติดธง" className="mt-6">
        <Table head={["สินค้า", "สถานะ", "เหตุผล", ""]} empty={flagged.length === 0}>
          {flagged.map((p) => (
            <tr key={p.id}>
              <Td>{truncate(p.name, 70)}</Td>
              <Td>
                {p.blacklisted && <Badge color="red">ซ่อนแล้ว</Badge>} {p.regulated && <Badge color="amber">ควบคุม</Badge>}
              </Td>
              <Td className="text-xs text-slate-500">{p.reason ?? "–"}</Td>
              <Td>
                {p.blacklisted && (
                  <form action={setProductBlacklist}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="on" value="false" />
                    <button className="text-xs text-blue-600 hover:underline">เลิกซ่อน</button>
                  </form>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
