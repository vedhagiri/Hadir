// "How it works" / pipeline page (P22).
//
// Static explainer visible to every authenticated role — replaces
// the placeholder mounted at /pipeline in earlier phases. Step cards
// use the ops-step classes (features/system/ops.css): numbered chip,
// icon tile, progress track and a hover lift.

import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "../../shell/Icon";
import "../system/opsUi";

interface Step {
  id:
    | "camera"
    | "capture"
    | "detection"
    | "identification"
    | "attendance"
    | "policy"
    | "report";
  icon: IconName;
}

const STEPS: Step[] = [
  { id: "camera", icon: "camera" },
  { id: "capture", icon: "activity" },
  { id: "detection", icon: "eye" },
  { id: "identification", icon: "user" },
  { id: "attendance", icon: "clock" },
  { id: "policy", icon: "shield" },
  { id: "report", icon: "fileText" },
];

export function PipelinePage() {
  const { t } = useTranslation();
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("pipeline.title")}</h1>
          <p className="page-sub">{t("pipeline.subtitle")}</p>
        </div>
      </div>

      <ol className="ops-steps" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {STEPS.map((step, i) => (
          <li key={step.id} className="ops-step">
            <div className="ops-step-top">
              <span className="ops-step-icon" aria-hidden="true">
                <Icon name={step.icon} size={22} />
              </span>
              <span className="ops-step-num" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
            </div>
            <h2 className="ops-step-title">{t(`pipeline.steps.${step.id}.title`)}</h2>
            <p className="ops-step-text">{t(`pipeline.steps.${step.id}.body`)}</p>
            <div className="ops-step-meta">
              <div className="ops-step-track" aria-hidden="true">
                {STEPS.map((s, j) => (
                  <span key={s.id} className={j <= i ? "is-done" : ""} />
                ))}
              </div>
              <div style={{ marginTop: 8 }}>
                {t("pipeline.stepOf", {
                  defaultValue: "step {{n}} / {{total}}",
                  n: i + 1,
                  total: STEPS.length,
                })}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
