// "How it works" / pipeline page (P22).
//
// Static explainer visible to every authenticated role — replaces
// the placeholder mounted at /pipeline in earlier phases. The
// design shipped a ``.pipeline-big`` grid + ``.pb-step`` card style
// in styles-enhancements2.css; this page reuses those classes so
// dark mode + density both pick up automatically.

import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "../../shell/Icon";

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
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 32,
            margin: "0 0 6px 0",
            fontWeight: 400,
            letterSpacing: "-0.01em",
          }}
        >
          {t("pipeline.title")}
        </h1>
        <p
          style={{
            margin: 0,
            color: "var(--text-secondary)",
            fontSize: 13.5,
            maxWidth: 720,
            lineHeight: 1.55,
          }}
        >
          {t("pipeline.subtitle")}
        </p>
      </header>

      <div className="pipeline-big">
        {STEPS.map((step, i) => (
          <article key={step.id} className="pb-step">
            <span className="pb-num" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div
              className="pb-icon"
              style={{
                background: "var(--accent-soft)",
                color: "var(--accent-text)",
              }}
              aria-hidden="true"
            >
              <Icon name={step.icon} size={22} />
            </div>
            <h2 className="pb-title">
              {t(`pipeline.steps.${step.id}.title`)}
            </h2>
            <p className="pb-text">{t(`pipeline.steps.${step.id}.body`)}</p>
            <div className="pb-meta">{`step ${i + 1} / ${STEPS.length}`}</div>
          </article>
        ))}
      </div>
    </div>
  );
}
