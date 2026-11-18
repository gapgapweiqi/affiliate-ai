"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "ภาพรวมวันนี้", en: "Daily Snapshot", icon: "📊" },
  { href: "/queue", label: "คิวโพสต์ถัดไป", en: "Post Queue", icon: "⏭️" },
  { href: "/revenue", label: "รายได้", en: "Revenue", icon: "💰" },
  { href: "/content", label: "คอนเทนต์", en: "Content", icon: "📝" },
  { href: "/trends", label: "เทรนด์และโอกาส", en: "Trends", icon: "📈" },
  { href: "/system", label: "สถานะระบบ", en: "System Health", icon: "🩺" },
  { href: "/compliance", label: "ความเสี่ยง", en: "Compliance", icon: "🛡️" },
  { href: "/actions", label: "สิ่งที่ต้องทำ", en: "Action Center", icon: "✅" },
];

export function Nav({ openAlerts }: { openAlerts: number }) {
  const path = usePathname();
  return (
    <nav className="space-y-1">
      {ITEMS.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
              active ? "bg-blue-50 font-semibold text-blue-700" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <span aria-hidden>{it.icon}</span>
            <span className="flex-1">
              {it.label}
              <span className="block text-[11px] font-normal text-slate-400">{it.en}</span>
            </span>
            {it.href === "/actions" && openAlerts > 0 && (
              <span className="rounded-full bg-rose-600 px-2 py-0.5 text-xs font-semibold text-white">{openAlerts}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
