import { Badge, Card, PageHeader, Table, Td, truncate } from "@/components/ui";
import { ago, baht, num, pct } from "@/lib/format";
import {
  getCoolingDown,
  getPostQueue,
  getPostsTodayByChannel,
  getVideoQueue,
  type QueueItem,
} from "@/lib/queries";

type Channel = "facebook" | "instagram" | "tiktok";

const CHANNELS: { key: Channel; label: string; capEnv: string; capDefault: number }[] = [
  { key: "facebook", label: "Facebook", capEnv: "DAILY_POSTS_FACEBOOK", capDefault: 5 },
  { key: "instagram", label: "Instagram", capEnv: "DAILY_POSTS_INSTAGRAM", capDefault: 5 },
  { key: "tiktok", label: "TikTok", capEnv: "DAILY_POSTS_TIKTOK", capDefault: 3 },
];

const flag = (k: string) => process.env[k] === "true" || process.env[k] === "1";

/** Would a post on this channel go out for real? Mirrors each publisher's dry-run gate. */
function isLive(channel: Channel): boolean {
  if (flag("DEBUG_DRY_RUN")) return false;
  if (channel === "facebook") return Boolean(process.env.META_PAGE_ACCESS_TOKEN && process.env.META_PAGE_ID);
  if (channel === "instagram") return Boolean(process.env.META_PAGE_ACCESS_TOKEN && process.env.META_INSTAGRAM_BUSINESS_ID);
  return Boolean(process.env.TIKTOK_ACCESS_TOKEN);
}

/* Bangkok is UTC+7 all year (no DST), so plain offset math is exact. */
const BKK_MS = 7 * 3600 * 1000;

function bkkLabel(d: Date): string {
  const b = new Date(d.getTime() + BKK_MS);
  const today = new Date(Date.now() + BKK_MS).getUTCDate();
  const hh = String(b.getUTCHours()).padStart(2, "0");
  const mm = String(b.getUTCMinutes()).padStart(2, "0");
  return `${b.getUTCDate() === today ? "วันนี้" : "พรุ่งนี้"} ${hh}:${mm} น.`;
}

/** Next run of a daily-ish cron "M1,M2 H1-H2 * * *" / "M H * * *" (the only shapes the bot uses). */
function nextRun(cron: string, from = new Date()): Date | null {
  const [mPart, hPart] = cron.trim().split(/\s+/);
  if (!mPart || !hPart) return null;
  const expand = (part: string, max: number) =>
    part === "*"
      ? Array.from({ length: max }, (_, i) => i)
      : part.split(",").flatMap((p) => {
          const [a, b] = p.split("-").map(Number);
          return b === undefined ? [a!] : Array.from({ length: b - a! + 1 }, (_, i) => a! + i);
        });
  const mins = expand(mPart, 60);
  const hours = expand(hPart, 24);
  const start = new Date(from.getTime() + BKK_MS);
  for (let add = 0; add < 2 * 24 * 60; add++) {
    const t = new Date(start.getTime() + add * 60_000);
    if (add === 0 && t.getUTCSeconds() > 0) continue;
    if (hours.includes(t.getUTCHours()) && mins.includes(t.getUTCMinutes())) {
      return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes()) - BKK_MS);
    }
  }
  return null;
}

function ScoreBar({ value }: { value: number | null }) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  const color = v >= 0.5 ? "bg-emerald-500" : v >= 0.3 ? "bg-blue-500" : v >= 0.15 ? "bg-amber-500" : "bg-rose-400";
  return (
    <div className="w-28">
      <div className="flex justify-between text-xs">
        <span className="font-semibold tabular-nums">{value == null ? "–" : v.toFixed(3)}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-100">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${v * 100}%` }} />
      </div>
    </div>
  );
}

function ProductCell({ p }: { p: QueueItem }) {
  return (
    <div className="flex items-center gap-3">
      {p.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.image} alt="" className="h-12 w-12 flex-none rounded-md border border-slate-200 object-cover" />
      ) : (
        <div className="h-12 w-12 flex-none rounded-md bg-slate-100" />
      )}
      <div className="min-w-0">
        <div className="text-sm">{truncate(p.name, 60)}</div>
        <div className="text-xs text-slate-400">#{p.id}</div>
      </div>
    </div>
  );
}

function QueueTable({ items, showPromo, nextLabel }: { items: QueueItem[]; showPromo: boolean; nextLabel: string }) {
  return (
    <Table
      head={["ลำดับ", "สินค้า", "คะแนนรวม", "องค์ประกอบ", "ราคา", "Rating", "Caption ที่ผ่าน", "โพสต์ล่าสุด"]}
      empty={items.length === 0}
    >
      {items.map((p, i) => (
        <tr key={p.id} className={i === 0 ? "bg-blue-50/60" : ""}>
          <Td className="whitespace-nowrap">
            {i === 0 ? <Badge color="blue">ถัดไป · {nextLabel}</Badge> : <span className="text-slate-500">{i + 1}</span>}
            {showPromo && p.isPromo && (
              <div className="mt-1">
                <Badge color="amber">โปร 6 ชม.</Badge>
              </div>
            )}
          </Td>
          <Td className="max-w-xs"><ProductCell p={p} /></Td>
          <Td><ScoreBar value={p.finalScore} /></Td>
          <Td className="whitespace-nowrap text-xs text-slate-600">
            <div>ความต้องการ {p.demandScore == null ? "–" : p.demandScore.toFixed(2)}</div>
            <div>ส่วนลด {p.dealScore == null ? "–" : p.dealScore.toFixed(2)}</div>
            <div>เทรนด์ {p.trendVelocity == null ? "–" : p.trendVelocity.toFixed(2)}</div>
          </Td>
          <Td className="whitespace-nowrap">
            {baht(p.currentPrice)}
            {p.discountPercent ? <div className="text-xs text-emerald-600">ลด {pct(p.discountPercent, 0)}</div> : null}
          </Td>
          <Td className="whitespace-nowrap text-sm">
            {p.rating ?? "–"}
            {p.soldCount ? <div className="text-xs text-slate-400">ขาย {num(p.soldCount)}</div> : null}
          </Td>
          <Td className="text-center">{p.approvedVariants}</Td>
          <Td className="whitespace-nowrap text-xs text-slate-500">{ago(p.lastPostedAt)}</Td>
        </tr>
      ))}
    </Table>
  );
}

export default async function QueuePage() {
  const photoCron = "10,40 8-22 * * *"; // src/scheduler/index.ts autoPublish
  const videoCron = process.env.CRON_VIDEO_POST || "30 22 * * *";
  const nextPhoto = nextRun(photoCron);
  const nextVideo = nextRun(videoCron);

  const [fbQueue, igQueue, ttQueue, cooling, today, videoQueue] = await Promise.all([
    getPostQueue("facebook", 10),
    getPostQueue("instagram", 5),
    getPostQueue("tiktok", 5),
    getCoolingDown("facebook"),
    getPostsTodayByChannel(),
    getVideoQueue(5),
  ]);
  const queues: Record<Channel, QueueItem[]> = { facebook: fbQueue, instagram: igQueue, tiktok: ttQueue };
  const todayBy = Object.fromEntries(today.map((t) => [t.channel, t]));

  return (
    <>
      <PageHeader
        title="คิวโพสต์รอบถัดไป"
        subtitle="Post Queue · ลำดับเดียวกับที่บอทใช้เลือกจริง: โปรใน 6 ชม. ก่อน → คะแนนรวม (final_score) → สินค้าใหม่"
      />

      <div className="grid gap-4 md:grid-cols-4">
        {CHANNELS.map((c) => {
          const cap = Number(process.env[c.capEnv] ?? c.capDefault);
          const live = todayBy[c.key]?.live ?? 0;
          const full = live >= cap;
          return (
            <Card key={c.key}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{c.label} · รูป</span>
                <Badge color={isLive(c.key) ? "green" : "gray"}>{isLive(c.key) ? "โพสต์จริง" : "จำลอง"}</Badge>
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">
                {live}/{cap}
                <span className="ml-1 text-xs font-normal text-slate-500">โพสต์วันนี้</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {full ? "ครบโควต้าวันนี้ — ข้ามจนถึงพรุ่งนี้" : `รอบถัดไป ${nextPhoto ? bkkLabel(nextPhoto) : "–"}`}
                {" · "}
                ในคิว {queues[c.key].length}
              </div>
            </Card>
          );
        })}
        <Card>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Facebook · วิดีโอ</span>
            <Badge color={isLive("facebook") ? "green" : "gray"}>{isLive("facebook") ? "โพสต์จริง" : "จำลอง"}</Badge>
          </div>
          <div className="mt-2 text-2xl font-semibold">{nextVideo ? bkkLabel(nextVideo) : "–"}</div>
          <div className="mt-1 text-xs text-slate-500">
            วันละ 1 คลิป · ต้องเปิด WanGP บนเครื่อง{process.env.WANGP_URL ? "" : " (ยังไม่ตั้ง WANGP_URL)"}
          </div>
        </Card>
      </div>

      <Card
        title="Facebook — โพสต์รูป + caption"
        subtitle={`รอบละ 1 สินค้า ทุก :10 และ :40 (08:00–22:00) · ต้องมี caption ที่ผ่าน Quality Gate และไม่ได้โพสต์ใน 24 ชม.`}
        className="mt-6"
      >
        <QueueTable items={fbQueue} showPromo nextLabel={nextPhoto ? bkkLabel(nextPhoto) : "–"} />
        {fbQueue.length === 0 && (
          <p className="mt-2 text-sm text-slate-500">
            ไม่มีสินค้าที่พร้อมโพสต์ — caption ใหม่จะถูกสร้างเมื่อ Promo Hunter เจอโปร
          </p>
        )}
      </Card>

      <Card
        title="Facebook — วิดีโอสินค้าพร้อมเสียง"
        subtitle="คะแนนสูงสุดที่ยังไม่มีวิดีโอใน 7 วัน · Sonnet เขียนบทและ caption ใหม่ทุกคลิป (ไม่ต้องมี caption รอไว้)"
        className="mt-6"
      >
        <QueueTable items={videoQueue} showPromo={false} nextLabel={nextVideo ? bkkLabel(nextVideo) : "–"} />
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="พักไว้ (โพสต์ไปแล้วใน 24 ชม.)" subtitle="Facebook · จะกลับเข้าคิวเมื่อครบ 24 ชม.">
          <Table head={["สินค้า", "คะแนน", "โพสต์เมื่อ"]} empty={cooling.length === 0}>
            {cooling.map((p) => (
              <tr key={p.id}>
                <Td>{truncate(p.name, 55)}</Td>
                <Td className="tabular-nums">{p.finalScore == null ? "–" : p.finalScore.toFixed(3)}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-500">{ago(p.lastPostedAt)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Instagram / TikTok" subtitle="คิวรูปของช่องทางอื่น (โพสต์จำลองจนกว่าจะตั้ง credential)">
          <div className="space-y-3 text-sm">
            {(["instagram", "tiktok"] as const).map((ch) => (
              <div key={ch}>
                <div className="font-medium capitalize">{ch}</div>
                {queues[ch].length === 0 ? (
                  <div className="text-xs text-slate-500">ไม่มีสินค้าที่มี caption สำหรับช่องทางนี้</div>
                ) : (
                  <ol className="ml-4 list-decimal text-xs text-slate-600">
                    {queues[ch].map((p) => (
                      <li key={p.id}>
                        {truncate(p.name, 50)} · {p.finalScore == null ? "–" : p.finalScore.toFixed(3)}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <p className="mt-6 text-xs text-slate-400">
        คะแนนรวม = ความต้องการ 30% + คุณภาพ/rating 20% + ส่วนลด 20% + เทรนด์ 10% + คลิกของเรา 10% + ร้านค้า 10% · หักคะแนนราคาล่อ
        (&lt; ฿20 หรือลด ≥ 90%) ×0.3 · คำนวณใหม่หลังดึงสินค้าทุกครั้ง
      </p>
    </>
  );
}
