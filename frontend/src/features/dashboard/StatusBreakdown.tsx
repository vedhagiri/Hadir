// Segmented-bar breakdown — replaces the design's UI.Donut for the
// pilot. Plain CSS (dash.css) rather than a charting lib (red line:
// no extra deps).

import type { ReactNode } from "react";

import { Panel, SegmentBar } from "./DashUi";
import type { Tone } from "./DashUi";

interface Slice {
  label: string;
  value: number;
  tone: Tone;
}

interface Props {
  title: string;
  slices: Slice[];
  caption?: string;
  /** Optional per-slice click (e.g. filter a table by that status). */
  onSelect?: (label: string) => void;
  /** Label of the currently selected slice, if any. */
  selected?: string | null;
  footer?: ReactNode;
}

export function StatusBreakdown({ title, slices, caption, onSelect, selected, footer }: Props) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  return (
    <Panel title={title} sub={caption}>
      <SegmentBar label={title} segments={slices.map((s) => ({ tone: s.tone, value: s.value, title: `${s.label} — ${s.value}` }))} />
      <div className="dsh-legend" style={{ marginTop: 14 }}>
        {slices.map((s) => {
          const pctTxt = total === 0 ? "—" : `${Math.round((s.value / total) * 100)}%`;
          const row = (
            <>
              <span aria-hidden className={`dsh-legend-dot is-${s.tone}`} />
              <span className="dsh-legend-label">{s.label}</span>
              <span className="dsh-legend-value">{s.value}</span>
              <span className="dsh-legend-pct">{pctTxt}</span>
            </>
          );
          return onSelect ? (
            <button key={s.label} type="button" className="dsh-legend-row" aria-pressed={selected === s.label} onClick={() => onSelect(s.label)}>
              {row}
            </button>
          ) : (
            <div key={s.label} className="dsh-legend-row">
              {row}
            </div>
          );
        })}
      </div>
      {footer}
    </Panel>
  );
}
