// P29 — Resources tab live timeseries chart.
//
// Single-line SVG chart with a metric-tab segmented control (CPU /
// Memory / IO Speed / SWAP) and a time-range selector (15m / 1h /
// 6h / 24h). Polls `/api/operations/resources/timeseries` every
// 10 s — same cadence as the backend sampler so we never sit
// halfway between two points.
//
// Inline SVG only (red line: no charting library). The grid, axis
// labels, polyline, and hover tooltip are hand-rolled. The visual
// target is the Sangfor-style operator dashboard the user shared
// in the request.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../../api/client";

type RangeKey = "15m" | "1h" | "6h" | "24h";
type MetricKey = "cpu" | "memory" | "io_speed" | "swap";

interface TimeseriesPoint {
  ts: number;
  cpu_percent: number;
  mem_percent: number;
  mem_used_mb: number;
  swap_percent: number;
  swap_used_mb: number;
  disk_read_mb_s: number;
  disk_write_mb_s: number;
  net_recv_mb_s: number;
  net_sent_mb_s: number;
  backend_cpu_percent: number;
  backend_mem_mb: number;
}

interface TimeseriesResponse {
  range: string;
  sample_interval_s: number;
  points: TimeseriesPoint[];
  generated_at: string;
}

function useTimeseries(range: RangeKey, enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "resources", "timeseries", range],
    queryFn: () =>
      api<TimeseriesResponse>(
        `/api/operations/resources/timeseries?range=${encodeURIComponent(range)}`,
      ),
    enabled,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

interface SeriesDef {
  label: string;
  values: number[];
  // Whether the y-axis is fixed 0–100 (CPU/Mem/Swap%) or auto-scaled
  // (IO speed in MB/s).
  yAxisMax: number | "auto";
  unit: string;
}

// Convert raw points + metric tab → the SeriesDef the renderer
// consumes. Kept in one place so adding a new metric is a single
// switch arm rather than a fan-out across the file.
function buildSeries(
  points: TimeseriesPoint[],
  metric: MetricKey,
  t: (key: string) => string,
): SeriesDef {
  switch (metric) {
    case "cpu":
      return {
        label: t("resources.chart.cpuLabel"),
        values: points.map((p) => p.cpu_percent),
        yAxisMax: 100,
        unit: "%",
      };
    case "memory":
      return {
        label: t("resources.chart.memLabel"),
        values: points.map((p) => p.mem_percent),
        yAxisMax: 100,
        unit: "%",
      };
    case "swap":
      return {
        label: t("resources.chart.swapLabel"),
        values: points.map((p) => p.swap_percent),
        yAxisMax: 100,
        unit: "%",
      };
    case "io_speed":
      return {
        label: t("resources.chart.ioLabel"),
        values: points.map(
          (p) => p.disk_read_mb_s + p.disk_write_mb_s,
        ),
        yAxisMax: "auto",
        unit: "MB/s",
      };
  }
}

const CHART_HEIGHT = 280;
const CHART_PADDING = {
  top: 16,
  right: 20,
  bottom: 30,
  left: 56,
};

function formatClockTick(ts: number, range: RangeKey): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (range === "24h" || range === "6h") {
    // Show day for the longer ranges so the operator sees the rollover.
    return `${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

function formatValue(v: number, unit: string): string {
  if (unit === "%") return `${v.toFixed(1)}%`;
  if (unit === "MB/s") return `${v.toFixed(2)} MB/s`;
  return v.toFixed(2);
}

interface ChartGeom {
  width: number;
  innerWidth: number;
  innerHeight: number;
  yMax: number;
  pointPositions: { x: number; y: number; v: number; ts: number }[];
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  pathD: string;
}

function buildGeometry(
  width: number,
  series: SeriesDef,
  points: TimeseriesPoint[],
  range: RangeKey,
): ChartGeom {
  const innerWidth = Math.max(50, width - CHART_PADDING.left - CHART_PADDING.right);
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

  // Empty / single-point payload — render the axis but no path.
  if (points.length === 0) {
    return {
      width,
      innerWidth,
      innerHeight,
      yMax: series.yAxisMax === "auto" ? 1 : series.yAxisMax,
      pointPositions: [],
      yTicks: [],
      xTicks: [],
      pathD: "",
    };
  }

  let yMax: number;
  if (series.yAxisMax === "auto") {
    const maxV = Math.max(0.5, ...series.values);
    // Round up to a friendlier scale.
    const exponent = Math.floor(Math.log10(maxV));
    const base = Math.pow(10, exponent);
    yMax = Math.ceil(maxV / base) * base;
    if (yMax < maxV * 1.05) yMax = maxV * 1.2;
  } else {
    yMax = series.yAxisMax;
  }

  const tsMin = points[0]!.ts;
  const tsMax = points[points.length - 1]!.ts;
  const tsRange = Math.max(1, tsMax - tsMin);

  const positions = points.map((p, i) => {
    const v = series.values[i] ?? 0;
    const x = CHART_PADDING.left + ((p.ts - tsMin) / tsRange) * innerWidth;
    const y =
      CHART_PADDING.top + innerHeight - (Math.min(v, yMax) / yMax) * innerHeight;
    return { x, y, v, ts: p.ts };
  });

  // Y-axis: 5 ticks (0, 25, 50, 75, 100) for percent; 5 evenly for auto.
  const yTicks: { y: number; label: string }[] = [];
  const yTickCount = 4;
  for (let i = 0; i <= yTickCount; i++) {
    const frac = i / yTickCount;
    const v = yMax * frac;
    const y = CHART_PADDING.top + innerHeight - frac * innerHeight;
    yTicks.push({
      y,
      label: series.unit === "%"
        ? `${Math.round(v)}%`
        : `${v < 10 ? v.toFixed(1) : Math.round(v)}`,
    });
  }

  // X-axis: ~6 ticks evenly across the visible range.
  const xTicks: { x: number; label: string }[] = [];
  const xTickCount = 6;
  for (let i = 0; i <= xTickCount; i++) {
    const frac = i / xTickCount;
    const ts = tsMin + tsRange * frac;
    const x = CHART_PADDING.left + frac * innerWidth;
    xTicks.push({ x, label: formatClockTick(ts, range) });
  }

  const pathD = positions
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");

  return {
    width,
    innerWidth,
    innerHeight,
    yMax,
    pointPositions: positions,
    yTicks,
    xTicks,
    pathD,
  };
}

function exportCsv(
  series: SeriesDef,
  points: TimeseriesPoint[],
  metric: MetricKey,
  range: RangeKey,
): void {
  const header = `ts_iso,${series.label.replace(/,/g, " ")}\n`;
  const lines = points.map((p, i) => {
    const v = series.values[i] ?? 0;
    return `${new Date(p.ts * 1000).toISOString()},${v.toFixed(3)}`;
  });
  const blob = new Blob([header + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `maugood-resources-${metric}-${range}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface HoverInfo {
  clientX: number;
  containerLeft: number;
  containerTop: number;
  containerWidth: number;
  // Index into series + points (they share length).
  index: number;
}

export function ResourceTimeseries({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<MetricKey>("cpu");
  const [range, setRange] = useState<RangeKey>("1h");
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Stable measured width — the chart redraws on resize via state.
  const [chartWidth, setChartWidth] = useState<number>(800);

  const q = useTimeseries(range, isAdmin);

  const series = useMemo(
    () =>
      buildSeries(
        q.data?.points ?? [],
        metric,
        (key: string) => t(key),
      ),
    [q.data?.points, metric, t],
  );
  const geom = useMemo(
    () => buildGeometry(chartWidth, series, q.data?.points ?? [], range),
    [chartWidth, series, q.data?.points, range],
  );

  // Measure the container on mount + whenever the window resizes.
  // No ResizeObserver dep — a window listener is sufficient.
  useEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        if (w > 0) setChartWidth(w);
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const onSvgMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (geom.pointPositions.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xInSvg = e.clientX - rect.left;
    // Find the nearest point.
    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < geom.pointPositions.length; i++) {
      const px = geom.pointPositions[i]!.x;
      const d = Math.abs(px - xInSvg);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }
    setHover({
      clientX: e.clientX,
      containerLeft: rect.left,
      containerTop: rect.top,
      containerWidth: rect.width,
      index: nearestIdx,
    });
  };

  const onSvgLeave = () => setHover(null);

  const currentValue =
    geom.pointPositions.length > 0
      ? geom.pointPositions[geom.pointPositions.length - 1]!.v
      : null;

  const metricOptions: { key: MetricKey; label: string }[] = [
    { key: "cpu", label: t("resources.chart.tabCpu") },
    { key: "memory", label: t("resources.chart.tabMemory") },
    { key: "io_speed", label: t("resources.chart.tabIo") },
    { key: "swap", label: t("resources.chart.tabSwap") },
  ];

  const rangeOptions: { key: RangeKey; label: string }[] = [
    { key: "15m", label: t("resources.chart.range15m") },
    { key: "1h", label: t("resources.chart.range1h") },
    { key: "6h", label: t("resources.chart.range6h") },
    { key: "24h", label: t("resources.chart.range24h") },
  ];

  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <div
          role="tablist"
          aria-label={t("resources.chart.tablistAria")}
          style={{ display: "flex", gap: 4 }}
        >
          {metricOptions.map((opt) => {
            const selected = metric === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setMetric(opt.key)}
                style={{
                  padding: "6px 14px",
                  fontSize: 13,
                  fontWeight: selected ? 600 : 500,
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: selected
                    ? "var(--accent, #0ea5e9)"
                    : "transparent",
                  color: selected
                    ? "var(--accent-fg, #ffffff)"
                    : "var(--text-secondary, #374151)",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label
            htmlFor="resources-range"
            className="text-dim"
            style={{ fontSize: 12 }}
          >
            {t("resources.chart.rangeLabel")}
          </label>
          <select
            id="resources-range"
            value={range}
            onChange={(e) => setRange(e.target.value as RangeKey)}
            style={{
              padding: "5px 8px",
              fontSize: 13,
              border: "1px solid var(--border, #e5e7eb)",
              borderRadius: 6,
              background: "var(--bg, #ffffff)",
            }}
          >
            {rangeOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              if (q.data) exportCsv(series, q.data.points, metric, range);
            }}
            disabled={!q.data || q.data.points.length === 0}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: 500,
              border: "1px solid var(--border, #e5e7eb)",
              borderRadius: 6,
              cursor: "pointer",
              background: "transparent",
              color: "var(--text-secondary, #374151)",
              opacity:
                !q.data || q.data.points.length === 0 ? 0.5 : 1,
            }}
          >
            {t("resources.chart.export")}
          </button>
        </div>
      </div>

      <div ref={containerRef} style={{ position: "relative" }}>
        {q.isLoading && (
          <div
            style={{
              height: CHART_HEIGHT,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-secondary, #6b7280)",
              fontSize: 13,
            }}
          >
            {t("resources.chart.loading")}
          </div>
        )}
        {!q.isLoading && q.data && (
          <>
            <svg
              width={geom.width}
              height={CHART_HEIGHT}
              role="img"
              aria-label={t("resources.chart.svgAria", {
                metric: series.label,
              })}
              onMouseMove={onSvgMove}
              onMouseLeave={onSvgLeave}
              style={{ display: "block" }}
            >
              {/* Y grid + labels */}
              {geom.yTicks.map((tk, i) => (
                <g key={`y-${i}`}>
                  <line
                    x1={CHART_PADDING.left}
                    y1={tk.y}
                    x2={geom.width - CHART_PADDING.right}
                    y2={tk.y}
                    stroke="var(--border-soft, #f3f4f6)"
                    strokeWidth={1}
                  />
                  <text
                    x={CHART_PADDING.left - 8}
                    y={tk.y + 4}
                    fontSize={10}
                    textAnchor="end"
                    fill="var(--text-secondary, #9ca3af)"
                  >
                    {tk.label}
                  </text>
                </g>
              ))}

              {/* X labels */}
              {geom.xTicks.map((tk, i) => (
                <text
                  key={`x-${i}`}
                  x={tk.x}
                  y={CHART_HEIGHT - CHART_PADDING.bottom + 16}
                  fontSize={10}
                  textAnchor="middle"
                  fill="var(--text-secondary, #9ca3af)"
                >
                  {tk.label}
                </text>
              ))}

              {/* Polyline path */}
              {geom.pathD && (
                <path
                  d={geom.pathD}
                  fill="none"
                  stroke="var(--accent, #0ea5e9)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}

              {/* Hover line + dot */}
              {hover && geom.pointPositions[hover.index] && (
                <>
                  <line
                    x1={geom.pointPositions[hover.index]!.x}
                    y1={CHART_PADDING.top}
                    x2={geom.pointPositions[hover.index]!.x}
                    y2={CHART_HEIGHT - CHART_PADDING.bottom}
                    stroke="var(--text-secondary, #9ca3af)"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                  />
                  <circle
                    cx={geom.pointPositions[hover.index]!.x}
                    cy={geom.pointPositions[hover.index]!.y}
                    r={4}
                    fill="var(--accent, #0ea5e9)"
                    stroke="white"
                    strokeWidth={2}
                  />
                </>
              )}
            </svg>

            {/* Hover tooltip overlay */}
            {hover && geom.pointPositions[hover.index] && (
              <div
                style={{
                  position: "absolute",
                  // Offset relative to the container, not the page.
                  left: Math.min(
                    geom.pointPositions[hover.index]!.x + 8,
                    geom.width - 130,
                  ),
                  top: Math.max(
                    8,
                    geom.pointPositions[hover.index]!.y - 50,
                  ),
                  background: "var(--bg, #ffffff)",
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 11,
                  pointerEvents: "none",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
                  whiteSpace: "nowrap",
                }}
              >
                <div
                  className="text-dim"
                  style={{ fontSize: 10, marginBottom: 2 }}
                >
                  {new Date(
                    geom.pointPositions[hover.index]!.ts * 1000,
                  ).toLocaleTimeString()}
                </div>
                <div style={{ fontWeight: 600 }}>
                  {formatValue(
                    geom.pointPositions[hover.index]!.v,
                    series.unit,
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          justifyContent: "center",
          marginTop: 8,
          fontSize: 12,
          color: "var(--text-secondary, #374151)",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 12,
            height: 3,
            background: "var(--accent, #0ea5e9)",
          }}
          aria-hidden="true"
        />
        <span style={{ fontWeight: 500 }}>{series.label}</span>
        {currentValue !== null && (
          <span className="text-dim">
            {t("resources.chart.currentLabel")}{" "}
            <span style={{ fontWeight: 600, color: "inherit" }}>
              {formatValue(currentValue, series.unit)}
            </span>
          </span>
        )}
        <span className="text-dim" style={{ marginInlineStart: "auto" }}>
          {t("resources.chart.samples", {
            count: q.data?.points.length ?? 0,
          })}
        </span>
      </div>
    </div>
  );
}
