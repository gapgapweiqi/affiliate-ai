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
  XAxis,
  YAxis,
} from "recharts";

export interface Series {
  key: string;
  label: string;
  color: string;
}

// Categorical palette (blue, teal, amber, rose) — distinguishable in light mode.
export const COLORS = { blue: "#2563eb", teal: "#0d9488", amber: "#d97706", rose: "#e11d48", slate: "#64748b" };

const axis = { fontSize: 12, fill: "#64748b" };

export function LineChart({ data, x, series, height = 260, valuePrefix = "" }: {
  data: Record<string, unknown>[];
  x: string;
  series: Series[];
  height?: number;
  valuePrefix?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid stroke="#e2e8f0" vertical={false} />
        <XAxis dataKey={x} tick={axis} tickLine={false} axisLine={false} />
        <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={valuePrefix !== ""} />
        <Tooltip formatter={(v: number) => `${valuePrefix}${valuePrefix ? v.toFixed(3) : v}`} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} />
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
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RBarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 8, right: 8, bottom: 0, left: horizontal ? 40 : -12 }}
      >
        <CartesianGrid stroke="#e2e8f0" vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tick={axis} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey={x} tick={axis} tickLine={false} axisLine={false} width={110} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} tickLine={false} axisLine={false} />
          </>
        )}
        <Tooltip formatter={(v: number) => `${valuePrefix}${valuePrefix ? v.toFixed(3) : v}`} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={s.color}
            stackId={stacked ? "a" : undefined}
            radius={stacked && i < series.length - 1 ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
          />
        ))}
      </RBarChart>
    </ResponsiveContainer>
  );
}
