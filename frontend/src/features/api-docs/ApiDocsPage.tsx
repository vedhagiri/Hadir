// API Reference page (P22).
//
// Admin-only — gated at the route level. Top section is an
// operator-facing overview (auth model, role gating, rate limits,
// tenant cookie). Below it, an iframe embeds Swagger UI served by
// FastAPI at ``/api/docs``. The iframe is same-origin (Vite
// proxies ^/api/) so the user's session cookie flows through and
// they can hit "Try it out" without any extra auth dance.

import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "../../shell/Icon";
import "../system/opsUi";

const DOCS_URL = "/api/docs";

const OVERVIEW: Array<{ key: "auth" | "tenant" | "roles" | "rateLimits"; icon: IconName }> = [
  { key: "auth", icon: "shield" },
  { key: "tenant", icon: "database" },
  { key: "roles", icon: "users" },
  { key: "rateLimits", icon: "clock" },
];

export function ApiDocsPage() {
  const { t } = useTranslation();
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("apiDocs.title")}</h1>
          <p className="page-sub">{t("apiDocs.subtitle")}</p>
        </div>
        <div className="page-actions">
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="btn">
            <Icon name="globe" size={12} />
            {t("apiDocs.openInNewTab")}
          </a>
        </div>
      </div>

      <section aria-labelledby="apidocs-overview-heading">
        <h2 id="apidocs-overview-heading" className="ops-section-label">
          {t("apiDocs.overview.title")}
        </h2>
        <div className="ops-overview">
          {OVERVIEW.map((item) => (
            <div key={item.key} className="card ops-overview-card">
              <span className="ops-stage-icon" style={{ width: 36, height: 36, background: "var(--accent-soft)", color: "var(--accent)" }} aria-hidden>
                <Icon name={item.icon} size={16} />
              </span>
              <p>{t(`apiDocs.overview.${item.key}`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card ops-card-flush" aria-labelledby="apidocs-embed-heading">
        <div className="card-head">
          <h2 id="apidocs-embed-heading" className="card-title" style={{ margin: 0 }}>
            {t("apiDocs.embedTitle")}
          </h2>
          <span className="pill pill-accent">
            <span className="pill-dot" aria-hidden />
            {t("apiDocs.liveBadge", { defaultValue: "Live" })}
          </span>
        </div>
        <iframe title={t("apiDocs.embedTitle")} src={DOCS_URL} className="ops-iframe" />
      </section>
    </>
  );
}
