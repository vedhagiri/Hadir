// Pure-SVG line chart with optional area fill, dot markers, and a
// horizontal reference line ("target"). Designed for short series
// (≤ 90 points). No interactivity beyond a tooltip on hover.

import { useState } from "react";

export interface LinePoint {
  label: string; // x-axis label (e.g. "Mon", "12 Apr")
  value: number; // primary metric, % or count
}

interface Props {
  data: LinePoint[];
  height?: number;
  yMin?: number;
  yMax?: number;
  /** Horizontal reference line (e.g. target = 96 for presence %). */
  target?: number | null;
  /** y-axis suffix shown in tooltips (e.g. "%"). */
  unit?: string;
  /** Stroke colour for the primary line. Defaults to var(--accent). */
  stroke?: string;
  /** Fill colour beneath the line. ``"none"`` disables. */
  area?: string;
}

export function LineChart({
  data,
  height = 180,
  yMin,
  yMax,
  target,
  unit = "",
  stroke = "var(--accent)",
  area = "var(--accent-soft, color-mix(in oklch, var(--accent) 18%, transparent))",
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const padX = 40;
  const padTop = 12;
  const padBottom = 28;
  const width = 600;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;

  if (data.length === 0) {
    return (
      <div
        className="text-sm text-dim"
        style={{
          height,
          display: "grid",
          placeItems: "center",
        }}
      >
        No data.
      </div>
    );
  }

  const lo = yMin ?? Math.min(...data.map((d) => d.value));
  const hi = yMax ?? Math.max(...data.map((d) => d.value));
  const span = Math.max(1, hi - lo);

  const x = (i: number) =>
    data.length === 1
      ? padX + innerW / 2
      : padX + (i / (data.length - 1)) * innerW;
  const y = (v: number) => padTop + innerH - ((v - lo) / span) * innerH;

  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.value)}`)
    .join(" ");
  const areaPath = `${linePath} L ${x(data.length - 1)} ${padTop + innerH} L ${x(0)} ${padTop + innerH} Z`;

  const targetY = target !== null && target !== undefined ? y(target) : null;

  // Tick labels — show 4 evenly spaced y ticks.
  const ticks = 4;
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) =>
    Math.round(lo + (span * i) / ticks),
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      preserveAspectRatio="none"
      role="img"
      aria-label="line chart"
      style={{ display: "block" }}
      onMouseLeave={() => setHover(null)}
    >
      {/* Grid lines */}
      {tickValues.map((v) => (
        <g key={`grid-${v}`}>
          <line
            x1={padX}
            x2={width - padX}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--border)"
            strokeWidth={0.5}
          />
          <text
            x={padX - 6}
            y={y(v)}
            textAnchor="end"
            dominantBaseline="central"
            style={{ fontSize: 10, fill: "var(--text-tertiary)" }}
          >
            {v}
            {unit}
          </text>
        </g>
      ))}

      {/* Area fill */}
      {area !== "none" && <path d={areaPath} fill={area} />}

      {/* Target reference line */}
      {targetY !== null && (
        <g>
          <line
            x1={padX}
            x2={width - padX}
            y1={targetY}
            y2={targetY}
            stroke="var(--text-tertiary)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <text
            x={width - padX}
            y={targetY - 4}
            textAnchor="end"
            style={{ fontSize: 10, fill: "var(--text-tertiary)" }}
          >
            target {target}
            {unit}
          </text>
        </g>
      )}

      {/* Primary line */}
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Hover dots */}
      {data.map((d, i) => (
        <g key={`pt-${i}`}>
          <circle
            cx={x(i)}
            cy={y(d.value)}
            r={hover === i ? 5 : 3}
            fill={stroke}
            stroke="var(--bg)"
            strokeWidth={1.5}
            style={{ transition: "r 80ms" }}
          />
          <rect
            x={x(i) - 14}
            y={padTop}
            width={28}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        </g>
      ))}

      {/* x-axis labels — every other when long */}
      {data.map((d, i) => {
        const stride = data.length > 14 ? 2 : 1;
        if (i % stride !== 0 && i !== data.length - 1) return null;
        return (
          <text
            key={`xt-${i}`}
            x={x(i)}
            y={height - 8}
            textAnchor="middle"
            style={{ fontSize: 10, fill: "var(--text-tertiary)" }}
          >
            {d.label}
          </text>
        );
      })}

      {/* Tooltip */}
      {hover !== null && data[hover] && (
        <g>
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={padTop}
            y2={padTop + innerH}
            stroke="var(--text-tertiary)"
            strokeWidth={0.5}
            strokeDasharray="2 2"
          />
          <g
            transform={`translate(${
              Math.min(width - padX - 80, Math.max(padX + 6, x(hover) + 8))
            } ${y(data[hover].value) - 28})`}
          >
            <rect
              width={84}
              height={32}
              rx={6}
              fill="var(--bg-elev)"
              stroke="var(--border)"
            />
            <text
              x={8}
              y={13}
              style={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            >
              {data[hover].label}
            </text>
            <text
              x={8}
              y={26}
              style={{
                fontSize: 12,
                fontWeight: 600,
                fill: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {data[hover].value}
              {unit}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}

// Tiny inline sparkline for KPI cards. No axes, no labels — just the
// shape of recent change.
export function Sparkline({
  values,
  stroke = "var(--accent)",
  width = 80,
  height = 24,
}: {
  values: number[];
  stroke?: string | undefined;
  width?: number;
  height?: number;
}) {
  if (values.length === 0) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(1, hi - lo);
  const x = (i: number) =>
    values.length === 1 ? width / 2 : (i / (values.length - 1)) * width;
  const y = (v: number) => height - ((v - lo) / span) * height;
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(v)}`)
    .join(" ");
  const last = values[values.length - 1] ?? 0;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ overflow: "visible" }}
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.5} fill={stroke} />
    </svg>
  );
}
