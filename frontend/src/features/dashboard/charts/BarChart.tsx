// Pure-SVG vertical bar chart used for distributions (e.g. arrivals
// per hour). Bars share a uniform colour by default; pass
// ``colorAt`` to highlight specific buckets.

interface Bar {
  label: string; // x-axis label (e.g. "06", "07", …)
  value: number;
}

interface Props {
  data: Bar[];
  height?: number;
  fill?: string;
  /** Optional per-bar colour override. */
  colorAt?: (i: number, bar: Bar) => string;
  /** y-axis suffix shown in tooltips/labels (e.g. "%"). */
  unit?: string;
  /** When true the largest bar's value is annotated above it. */
  annotateMax?: boolean;
}

export function BarChart({
  data,
  height = 160,
  fill = "var(--accent)",
  colorAt,
  unit = "",
  annotateMax = true,
}: Props) {
  const padX = 12;
  const padTop = 18;
  const padBottom = 22;
  const width = 600;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;

  if (data.length === 0) {
    return (
      <div
        className="text-sm text-dim"
        style={{ height, display: "grid", placeItems: "center" }}
      >
        No data.
      </div>
    );
  }

  const maxV = Math.max(1, ...data.map((b) => b.value));
  const slot = innerW / data.length;
  const barW = Math.max(2, slot * 0.7);
  const maxIdx = data.findIndex((b) => b.value === maxV);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      preserveAspectRatio="none"
      style={{ display: "block" }}
      role="img"
      aria-label="bar chart"
    >
      {/* Baseline */}
      <line
        x1={padX}
        x2={width - padX}
        y1={padTop + innerH}
        y2={padTop + innerH}
        stroke="var(--border)"
        strokeWidth={0.5}
      />

      {data.map((b, i) => {
        const x = padX + i * slot + (slot - barW) / 2;
        const h = (b.value / maxV) * innerH;
        const y = padTop + innerH - h;
        const colour = colorAt ? colorAt(i, b) : fill;
        return (
          <g key={`${b.label}-${i}`}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(b.value > 0 ? 2 : 0, h)}
              rx={3}
              fill={colour}
            />
            {annotateMax && i === maxIdx && b.value > 0 && (
              <text
                x={x + barW / 2}
                y={y - 4}
                textAnchor="middle"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  fill: "var(--text)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {b.value}
                {unit}
              </text>
            )}
            <text
              x={x + barW / 2}
              y={padTop + innerH + 14}
              textAnchor="middle"
              style={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            >
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
