// Skeleton loaders (ported from the LPA demo's components/ui/Skeleton.jsx).
//
// Rule: a loading state is SHAPE-MATCHED to the layout it stands in for —
// never a bare "Loading…" line. The page doesn't jump when real content
// lands, and the user reads what is coming before it arrives, which makes
// the wait feel shorter.
//
// Pick the primitive that matches what you are replacing:
//
//   <SkeletonRows cols={7} />            rows inside an existing <tbody>
//   <SkeletonTable rows={7} cols={5} />  a whole table, header included
//   <SkeletonCards count={4} />          a row of KPI / stat tiles
//   <SkeletonGrid count={8} avatar />    a grid of cards (people, crops…)
//   <SkeletonPanel lines={5} />          a card with heading + body lines
//   <SkeletonLines lines={3} />          body lines inside an existing card
//   <SkeletonChart height={220} />       a chart area
//   <SkeletonCalendar />                 a month grid
//   <SkeletonLine width="60%" />         one line, for bespoke layouts
//
// Containers carry role="status" + an aria-label so a screen reader
// announces "loading" once instead of reading out empty boxes.

import type { CSSProperties } from "react";

import "./skeleton.css";

export function SkeletonLine({
  width = "100%",
  height = 11,
  radius,
  style,
}: {
  width?: number | string;
  height?: number;
  radius?: number | string;
  style?: CSSProperties;
}) {
  return (
    <span
      className="sk sk-line"
      aria-hidden="true"
      style={{ display: "block", width, height, ...(radius !== undefined ? { borderRadius: radius } : {}), ...style }}
    />
  );
}

/** Inline placeholder sized like a chip (for chip lists that load late). */
export function SkeletonChip({ width = 72 }: { width?: number }) {
  return (
    <span role="status" aria-label="Loading" style={{ display: "inline-block", verticalAlign: "middle" }}>
      <SkeletonLine width={width} height={18} radius={999} />
    </span>
  );
}

/** Body lines of decreasing width, for use inside an existing card/drawer. */
export function SkeletonLines({ lines = 3, gap = 10 }: { lines?: number; gap?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: "flex", flexDirection: "column", gap, padding: "4px 0" }}>
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonLine key={i} width={`${Math.max(35, 95 - i * 12)}%`} />
      ))}
    </div>
  );
}

/**
 * Placeholder rows for an existing table body. Rows fade progressively so
 * a tall skeleton doesn't read as a solid grey block (floored at 0.15 so
 * the tail stays faintly visible).
 */
export function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  const shown = Math.max(1, Math.min(cols, 14));
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden={r > 0 ? true : undefined} role={r === 0 ? "status" : undefined} aria-label={r === 0 ? "Loading" : undefined} style={{ opacity: Math.max(0.15, 1 - r * 0.12) }}>
          {Array.from({ length: shown }, (_, c) => (
            <td key={c} style={{ padding: "14px 10px" }}>
              <SkeletonLine width={c === 0 ? "75%" : `${45 + ((c * 17 + r * 7) % 40)}%`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** A full table, header included, for spots that render no table yet. */
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading table" style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--bg-elev)" }}>
      <div style={{ display: "flex", gap: 16, padding: "11px 12px", background: "var(--bg-sunken)", borderBottom: "1px solid var(--border)" }}>
        {Array.from({ length: cols }, (_, c) => (
          <SkeletonLine key={c} width={`${Math.round(60 / cols)}%`} height={9} style={{ background: "var(--border)" }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          style={{
            display: "flex",
            gap: 16,
            padding: "14px 12px",
            opacity: Math.max(0.15, 1 - r * 0.1),
            borderBottom: r === rows - 1 ? "none" : "1px solid var(--border)",
          }}
        >
          {Array.from({ length: cols }, (_, c) => (
            <SkeletonLine key={c} width={c === 0 ? "22%" : `${10 + c * 4}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A row of stat tiles: label, figure, sub-label. */
export function SkeletonCards({ count = 4, minWidth = 200 }: { count?: number; minWidth?: number }) {
  return (
    <div role="status" aria-label="Loading statistics" style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`, gap: 14 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16, border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-elev)" }}>
          <SkeletonLine width="55%" height={9} />
          <SkeletonLine width="38%" height={26} />
          <SkeletonLine width="42%" height={9} />
        </div>
      ))}
    </div>
  );
}

/** A grid of cards — avatar cards (people) or image tiles (crops, clips). */
export function SkeletonGrid({ count = 8, avatar = false, minWidth = 176 }: { count?: number; avatar?: boolean; minWidth?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`, gap: 14 }}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: avatar ? "center" : "stretch",
            gap: 10,
            padding: avatar ? "18px 12px 16px" : 12,
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--bg-elev)",
            opacity: Math.max(0.25, 1 - i * 0.06),
          }}
        >
          {avatar ? <SkeletonLine width={64} height={64} radius="50%" /> : <SkeletonLine height={120} radius={8} />}
          <SkeletonLine width={avatar ? "70%" : "60%"} height={12} />
          <SkeletonLine width={avatar ? "40%" : "35%"} height={9} />
        </div>
      ))}
    </div>
  );
}

/** A card: heading, then body lines of decreasing width. */
export function SkeletonPanel({ lines = 5 }: { lines?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-elev)" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <SkeletonLine width="30%" height={14} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        {Array.from({ length: lines }, (_, i) => (
          <SkeletonLine key={i} width={`${Math.max(35, 95 - i * 9)}%`} />
        ))}
      </div>
    </div>
  );
}

/** A chart area: axis ticks on the left, bars rising along the bottom. */
export function SkeletonChart({ height = 220 }: { height?: number }) {
  const bars = [42, 64, 55, 78, 60, 86, 70, 52, 74, 66, 58, 80];
  return (
    <div role="status" aria-label="Loading chart" style={{ display: "flex", gap: 12, height, padding: "8px 4px" }}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 28 }}>
        {[0, 1, 2, 3].map((i) => (
          <SkeletonLine key={i} width={24} height={8} />
        ))}
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 8, borderBottom: "1px solid var(--border)" }}>
        {bars.map((h, i) => (
          <SkeletonLine key={i} height={Math.round(((height - 30) * h) / 100)} radius="6px 6px 0 0" style={{ flex: 1, width: "auto" }} />
        ))}
      </div>
    </div>
  );
}

/** A month grid: weekday header + 5 rows of 7 day cells. */
export function SkeletonCalendar() {
  return (
    <div role="status" aria-label="Loading calendar" className="card" style={{ padding: 16 }}>
      <SkeletonLine height={34} radius={8} style={{ marginBottom: 6 }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
        {Array.from({ length: 35 }, (_, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, minHeight: 86, padding: 10, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
            <SkeletonLine width={16} height={12} />
            <SkeletonLine width="70%" height={9} style={{ alignSelf: "flex-start" }} />
            <SkeletonLine width="50%" height={9} style={{ alignSelf: "flex-start" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Whole-page placeholder: title, stat row, table. */
export function SkeletonPage() {
  return (
    <div role="status" aria-label="Loading page" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SkeletonLine width={260} height={26} />
        <SkeletonLine width={360} height={12} />
      </div>
      <SkeletonCards count={4} />
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}
