// Pure-SVG donut chart. No deps. Each slice is rendered as an SVG
// <path> arc; the center carries an optional label + sublabel.

interface Slice {
  label: string;
  value: number;
  color: string;
}

interface Props {
  slices: Slice[];
  size?: number;
  thickness?: number;
  centerValue?: string;
  centerLabel?: string;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startDeg: number,
  endDeg: number,
): string {
  // Guard: a full-circle arc renders as nothing under SVG large-arc rules
  // because start == end. Inset by a hair so the outer ring still draws.
  if (endDeg - startDeg >= 360) endDeg = startDeg + 359.999;
  const [x1, y1] = polar(cx, cy, rOuter, startDeg);
  const [x2, y2] = polar(cx, cy, rOuter, endDeg);
  const [x3, y3] = polar(cx, cy, rInner, endDeg);
  const [x4, y4] = polar(cx, cy, rInner, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    "Z",
  ].join(" ");
}

export function Donut({
  slices,
  size = 140,
  thickness = 22,
  centerValue,
  centerLabel,
}: Props) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 2;
  const rInner = rOuter - thickness;

  let cursor = 0;
  const arcs =
    total === 0
      ? null
      : slices
          .filter((s) => s.value > 0)
          .map((s) => {
            const sweep = (s.value / total) * 360;
            const path = arcPath(cx, cy, rOuter, rInner, cursor, cursor + sweep);
            cursor += sweep;
            return <path key={s.label} d={path} fill={s.color} />;
          });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${centerLabel ?? "donut"} chart`}
    >
      {/* Track ring */}
      <circle
        cx={cx}
        cy={cy}
        r={(rOuter + rInner) / 2}
        fill="none"
        stroke="var(--bg-sunken)"
        strokeWidth={thickness}
      />
      {arcs}
      {centerValue && (
        <text
          x={cx}
          y={cy - 2}
          textAnchor="middle"
          dominantBaseline="central"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: size * 0.22,
            fontWeight: 600,
            fill: "var(--text)",
          }}
        >
          {centerValue}
        </text>
      )}
      {centerLabel && (
        <text
          x={cx}
          y={cy + size * 0.14}
          textAnchor="middle"
          dominantBaseline="central"
          style={{
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fill: "var(--text-tertiary)",
          }}
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
}
