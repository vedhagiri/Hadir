// Four-pill pipeline indicator for one worker.
//
// Each pill shows: green/amber/red/unknown dot + stage label + the
// detail string the backend computed. Vertical layout on narrow
// viewports; horizontal on wide.

import { useTranslation } from "react-i18next";

import type { PipelineStages as PipelineStagesType, StageState } from "./types";

interface Props {
  stages: PipelineStagesType;
}

const STAGE_KEYS = [
  "rtsp",
  "detection",
  "matching",
  "attendance",
] as const;

const STATE_DOT_COLOR: Record<StageState, string> = {
  green: "var(--success)",
  amber: "var(--warning)",
  red: "var(--danger)",
  unknown: "var(--text-quaternary)",
};

const STATE_BG: Record<StageState, string> = {
  green: "var(--success-soft)",
  amber: "var(--warning-soft)",
  red: "var(--danger-soft)",
  unknown: "var(--bg-sunken)",
};

const STATE_BORDER: Record<StageState, string> = {
  green: "var(--success-border, var(--border))",
  amber: "var(--warning-border, var(--border))",
  red: "var(--danger-border, var(--border))",
  unknown: "var(--border)",
};

export function PipelineStagesView({ stages }: Props) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 8,
      }}
    >
      {STAGE_KEYS.map((key) => {
        const stage = stages[key];
        const label = t(`operations.stages.${key}`) as string;
        return (
          <div
            key={key}
            style={{
              border: `1px solid ${STATE_BORDER[stage.state]}`,
              background: STATE_BG[stage.state],
              borderRadius: "var(--radius-sm)",
              padding: "8px 10px",
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: STATE_DOT_COLOR[stage.state],
                marginTop: 4,
                flexShrink: 0,
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--text-secondary)",
                }}
              >
                {label}
              </div>
              <div
                className="text-xs"
                style={{
                  marginTop: 2,
                  lineHeight: 1.4,
                  color: "var(--text)",
                  wordBreak: "break-word",
                }}
              >
                {stage.detail || t(`operations.stageState.${stage.state}`)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
