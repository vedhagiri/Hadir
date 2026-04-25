// API Reference page (P22).
//
// Admin-only — gated at the route level. Top section is an
// operator-facing overview (auth model, role gating, rate limits,
// tenant cookie). Below it, an iframe embeds Swagger UI served by
// FastAPI at ``/api/docs``. The iframe is same-origin (Vite
// proxies ^/api/) so the user's session cookie flows through and
// they can hit "Try it out" without any extra auth dance.

import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";

const DOCS_URL = "/api/docs";

export function ApiDocsPage() {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
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
          {t("apiDocs.title")}
        </h1>
        <p
          style={{
            margin: 0,
            color: "var(--text-secondary)",
            fontSize: 13.5,
            maxWidth: 760,
            lineHeight: 1.55,
          }}
        >
          {t("apiDocs.subtitle")}
        </p>
      </header>

      <section
        className="card"
        aria-labelledby="apidocs-overview-heading"
        style={{
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <h2
          id="apidocs-overview-heading"
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontSize: 20,
            fontWeight: 400,
          }}
        >
          {t("apiDocs.overview.title")}
        </h2>
        <ul
          style={{
            margin: 0,
            paddingInlineStart: 18,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            color: "var(--text-secondary)",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <li>{t("apiDocs.overview.auth")}</li>
          <li>{t("apiDocs.overview.tenant")}</li>
          <li>{t("apiDocs.overview.roles")}</li>
          <li>{t("apiDocs.overview.rateLimits")}</li>
        </ul>
      </section>

      <section
        className="card"
        aria-labelledby="apidocs-embed-heading"
        style={{ padding: 0, overflow: "hidden" }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-sunken)",
          }}
        >
          <h2
            id="apidocs-embed-heading"
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {t("apiDocs.embedTitle")}
          </h2>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Icon name="globe" size={12} />
            {t("apiDocs.openInNewTab")}
          </a>
        </header>
        <iframe
          title={t("apiDocs.embedTitle")}
          src={DOCS_URL}
          style={{
            width: "100%",
            height: "70vh",
            border: 0,
            display: "block",
            background: "var(--bg)",
          }}
        />
      </section>
    </div>
  );
}
