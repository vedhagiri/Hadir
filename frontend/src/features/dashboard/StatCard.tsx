// Tiny stat card used by every dashboard. Visual style follows
// design/dashboards.jsx::UI.StatCard but without the synthetic
// sparkline — the pilot doesn't have historical aggregate data yet,
// and faking it would mislead an operator looking at the demo.

import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";

interface Props {
  label: string;
  value: string;
  sub?: string;
  icon: IconName;
}

export function StatCard({ label, value, sub, icon }: Props) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            background: "var(--bg-sunken)",
            display: "grid",
            placeItems: "center",
            color: "var(--text-secondary)",
          }}
        >
          <Icon name={icon} size={14} />
        </div>
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 28,
          letterSpacing: "-0.01em",
          marginTop: 4,
        }}
      >
        {value}
      </div>
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginTop: 6,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      {sub && (
        <div className="text-xs text-dim" style={{ marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
