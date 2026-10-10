// Four-stage health strip for one worker.
//
// Each stage card shows: a tone pill (green / amber / red / unknown),
// the stage label, a progress bar that reflects the state, and the
// detail string the backend computed.

import { useTranslation } from "react-i18next";

import { ProgressBar, SoftPill, type PillTone } from "../system/opsUi";
import type { PipelineStages as PipelineStagesType, StageState } from "./types";

interface Props {
  stages: PipelineStagesType;
}

const STAGE_KEYS = ["rtsp", "detection", "matching", "attendance"] as const;

export const STAGE_TONE: Record<StageState, PillTone> = {
  green: "success",
  amber: "warning",
  red: "danger",
  unknown: "neutral",
};

const STAGE_PCT: Record<StageState, number> = {
  green: 100,
  amber: 60,
  red: 20,
  unknown: 0,
};

export function PipelineStagesView({ stages }: Props) {
  const { t } = useTranslation();
  return (
    <div className="ops-stage-grid">
      {STAGE_KEYS.map((key) => {
        const stage = stages[key];
        const tone = STAGE_TONE[stage.state];
        const label = t(`operations.stages.${key}`) as string;
        const stateLabel = t(`operations.stageState.${stage.state}`) as string;
        return (
          <div key={key} className={`ops-stage tone-${tone}`}>
            <div className="ops-stage-head">
              <span className="ops-stage-title">{label}</span>
              <SoftPill tone={tone}>{stateLabel}</SoftPill>
            </div>
            <ProgressBar value={STAGE_PCT[stage.state]} tone={tone} thin label={`${label}: ${stateLabel}`} />
            <div className="ops-stage-detail">{stage.detail || stateLabel}</div>
          </div>
        );
      })}
    </div>
  );
}
