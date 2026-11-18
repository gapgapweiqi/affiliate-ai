import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, subtitle, children, className = "" }: { title?: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {title && (
        <header className="mb-4">
          <h2 className="font-semibold text-slate-800">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, delta }: { label: string; value: ReactNode; hint?: string; delta?: { now: number; prev: number } }) {
  let deltaEl: ReactNode = null;
  if (delta) {
    const diff = delta.now - delta.prev;
    const cls = diff > 0 ? "text-emerald-600" : diff < 0 ? "text-rose-600" : "text-slate-400";
    deltaEl = (
      <span className={`text-xs font-medium ${cls}`}>
        {diff > 0 ? "▲" : diff < 0 ? "▼" : "•"} {Math.abs(diff)} จากเมื่อวาน
      </span>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
      <div className="mt-1 flex items-center gap-2">
        {deltaEl}
        {hint && <span className="text-xs text-slate-400">{hint}</span>}
      </div>
    </div>
  );
}

const BADGE: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  red: "bg-rose-50 text-rose-700 ring-rose-600/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
  gray: "bg-slate-50 text-slate-600 ring-slate-500/20",
};

export function Badge({ color = "gray", children }: { color?: keyof typeof BADGE; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[color]}`}>
      {children}
    </span>
  );
}

export function statusColor(status: string): keyof typeof BADGE {
  if (["published", "success", "info"].includes(status)) return "green";
  if (["failed", "error", "critical"].includes(status)) return "red";
  if (["partial", "rate_limited", "warn", "publishing", "running"].includes(status)) return "amber";
  return "gray";
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-5 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {empty ? (
            <tr>
              <td colSpan={head.length} className="px-5 py-8 text-center text-slate-400">ยังไม่มีข้อมูล</td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-5 py-2 align-top ${className}`}>{children}</td>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function truncate(s: string | null | undefined, n: number) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
