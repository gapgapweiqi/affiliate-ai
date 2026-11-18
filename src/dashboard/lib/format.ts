const nf = new Intl.NumberFormat("th-TH");

export const num = (n: number | string | null | undefined) => nf.format(Number(n ?? 0));

/** Prices/revenue are stored in satang (1 baht = 100 satang). */
export const baht = (satang: number | string | null | undefined) =>
  `฿${nf.format(Math.round(Number(satang ?? 0) / 100))}`;

/** Costs are stored in micro-USD. */
export const usd = (micros: number | string | null | undefined, digits = 2) =>
  `$${(Number(micros ?? 0) / 1_000_000).toFixed(digits)}`;

export const pct = (v: number | string | null | undefined, digits = 1) =>
  v == null ? "–" : `${(Number(v) * 100).toFixed(digits)}%`;

export function ago(ts: string | Date | null | undefined): string {
  if (!ts) return "–";
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s} วิที่แล้ว`;
  if (s < 3600) return `${Math.round(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.round(s / 3600)} ชม.ที่แล้ว`;
  return `${Math.round(s / 86400)} วันที่แล้ว`;
}

export function dateTime(ts: string | Date | null | undefined): string {
  if (!ts) return "–";
  return new Date(ts).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "short",
    timeStyle: "short",
  });
}

export const NICHE_LABEL: Record<string, string> = {
  it_gadget: "IT & Gadget",
  beauty: "ความงาม",
  home_appliance: "เครื่องใช้ในบ้าน",
  sports_fitness: "กีฬาและฟิตเนส",
  mom_baby: "แม่และเด็ก",
  food_kitchen: "อาหารและครัว",
  fashion: "แฟชั่น",
  car_garage: "รถยนต์",
};
