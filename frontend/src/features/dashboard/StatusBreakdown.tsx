// Tiny stacked-bar breakdown — replaces the design's UI.Donut for the
// pilot. We do this with plain CSS rather than pull in a charting lib
// (red line: no extra deps).

interface Slice {
  label: string;
  value: number;
  tone: "accent" | "warning" | "info" | "danger" | "success" | "neutral";
}

const TONE_COLOR: Record<Slice["tone"], string> = {
  accent: "var(--accent)",
  warning: "var(--warning)",
  info: "var(--info)",
  danger: "var(--danger)",
  success: "var(--success)",
  neutral: "var(--text-tertiary)",
};

interface Props {
  title: string;
  slices: Slice[];
  caption?: string;
}

export function StatusBreakdown({ title, slices, caption }: Props) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{title}</h3>
        {caption && <span className="text-xs text-dim mono">{caption}</span>}
      </div>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          style={{
            display: "flex",
            height: 10,
            borderRadius: 6,
            overflow: "hidden",
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
          }}
        >
          {total === 0 ? (
            <div style={{ flex: 1, background: "var(--bg-sunken)" }} />
          ) : (
            slices.map((s) =>
              s.value > 0 ? (
                <div
                  key={s.label}
                  style={{
                    flex: s.value,
                    background: TONE_COLOR[s.tone],
                  }}
                  title={`${s.label} — ${s.value}`}
                />
              ) : null,
            )
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {slices.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-2"
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: TONE_COLOR[s.tone],
                }}
              />
              <span style={{ flex: 1 }}>{s.label}</span>
              <span className="mono text-dim">
                {total === 0 ? "—" : `${s.value} (${Math.round((s.value / total) * 100)}%)`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
