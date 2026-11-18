"use client";

import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";

export interface Series {
  key: string;
  label: string;
  /** Fixed palette slot (0-based) so an entity keeps its color across charts,
   *  e.g. in small multiples. Defaults to the series' position. */
  slot?: number;
}

/**
 * Categorical palette, assigned by series position in fixed order — never
 * cycled, never passed in from a page. (Constants exported from a
 * "use client" module reach server components as opaque references, which
 * is why the old per-page COLORS props rendered as Recharts' default.)
 * Validated on the white card surface: lightness band, chroma, CVD ΔE ≥ 9,
 * normal-vision ΔE ≥ 27. Slot 3 is < 3:1 on white, so every chart keeps a
 * legend/tooltip and the pages carry tables.
 */
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"] as const;
const SURFACE = "#ffffff";
const INK = { primary: "#1e293b", secondary: "#475569", muted: "#94a3b8", grid: "#eef2f6" };

const nf = new Intl.NumberFormat("th-TH");
const axis = { fontSize: 12, fill: INK.muted };

function color(i: number): string {
  return SERIES_COLORS[Math.min(i, SERIES_COLORS.length - 1)]!;
}

function formatValue(v: unknown, prefix: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "–");
  return prefix ? `${prefix}${n.toFixed(3)}` : nf.format(n);
}

/** Tooltip: text in ink tokens; a small swatch carries series identity. */
function ChartTooltip({ active, payload, label, prefix }: TooltipProps<number, string> & { prefix: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium" style={{ color: INK.primary }}>{label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2" style={{ color: INK.secondary }}>
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
          <span className="flex-1">{p.name}</span>
          <span className="tabular-nums font-medium" style={{ color: INK.primary }}>{formatValue(p.value, prefix)}</span>
        </div>
      ))}
    </div>
  );
}

const legendProps = {
  iconType: "circle" as const,
  iconSize: 8,
  wrapperStyle: { fontSize: 12, color: INK.secondary, paddingTop: 4 },
  formatter: (value: string) => <span style={{ color: INK.secondary }}>{value}</span>,
};

export function LineChart({ data, x, series, height = 260, valuePrefix = "" }: {
  data: Record<string, unknown>[];
  x: string;
  series: Series[];
  height?: number;
  valuePrefix?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={INK.grid} vertical={false} />
        <XAxis dataKey={x} tick={axis} tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={valuePrefix !== ""} tickFormatter={(v) => nf.format(v)} />
        <Tooltip content={<ChartTooltip prefix={valuePrefix} />} cursor={{ stroke: INK.muted, strokeDasharray: "3 3" }} />
        {series.length > 1 && <Legend {...legendProps} />}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={color(s.slot ?? i)}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: color(s.slot ?? i), stroke: SURFACE, strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </RLineChart>
    </ResponsiveContainer>
  );
}

export function BarChart({ data, x, series, height = 260, stacked = false, horizontal = false, valuePrefix = "" }: {
  data: Record<string, unknown>[];
  x: string;
  series: Series[];
  height?: number;
  stacked?: boolean;
  horizontal?: boolean;
  valuePrefix?: string;
}) {
  const end: [number, number, number, number] = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RBarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 8, right: 12, bottom: 0, left: horizontal ? 40 : -12 }}
        barGap={2}
        barCategoryGap="24%"
      >
        <CartesianGrid stroke={INK.grid} vertical={horizontal} horizontal={!horizontal} />
        {/* Axes must be direct children — Recharts does not look inside Fragments,
            and without the category axis every bar collapses onto y=0. */}
        <XAxis
          type={horizontal ? "number" : "category"}
          dataKey={horizontal ? undefined : x}
          tick={axis}
          tickLine={false}
          axisLine={false}
          minTickGap={8}
          tickFormatter={horizontal ? (v) => nf.format(v) : undefined}
        />
        <YAxis
          type={horizontal ? "category" : "number"}
          dataKey={horizontal ? x : undefined}
          tick={horizontal ? { ...axis, fill: INK.secondary } : axis}
          tickLine={false}
          axisLine={false}
          width={horizontal ? 110 : 60}
          tickFormatter={horizontal ? undefined : (v) => nf.format(v)}
        />
        <Tooltip content={<ChartTooltip prefix={valuePrefix} />} cursor={{ fill: "#f1f5f9" }} />
        {series.length > 1 && <Legend {...legendProps} />}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={color(s.slot ?? i)}
            // 2px surface gap between stacked segments / adjacent bars
            stroke={SURFACE}
            strokeWidth={stacked ? 2 : 0}
            maxBarSize={horizontal ? 22 : 36}
            stackId={stacked ? "a" : undefined}
            radius={stacked && i < series.length - 1 ? 0 : end}
            isAnimationActive={false}
          />
        ))}
      </RBarChart>
    </ResponsiveContainer>
  );
}
