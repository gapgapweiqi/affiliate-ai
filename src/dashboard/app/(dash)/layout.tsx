import { sql } from "drizzle-orm";
import { logout } from "../actions";
import { Nav } from "@/components/nav";
import { one } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const counts = await one<{ openAlerts: number }>(
    sql`SELECT count(*)::int AS "openAlerts" FROM alerts WHERE resolved_at IS NULL`,
  );
  const dryRun = process.env.DEBUG_DRY_RUN === "true" || process.env.DEBUG_DRY_RUN === "1";
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">A</span>
          <div>
            <p className="text-sm font-semibold text-slate-900">Affiliate AI</p>
            <p className="text-[11px] text-slate-500">ระบบหลังบ้าน</p>
          </div>
        </div>
        <Nav openAlerts={counts?.openAlerts ?? 0} />
        <div className="mt-auto space-y-3 px-2">
          {dryRun && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              โหมดทดลอง (DRY RUN) — ยังไม่มีการโพสต์จริง
            </p>
          )}
          <form action={logout}>
            <button className="text-xs text-slate-500 hover:text-slate-800">ออกจากระบบ</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6 lg:p-8">{children}</main>
    </div>
  );
}
