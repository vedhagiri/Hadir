// Users page (Admin) — its own top-level sidebar nav item (/users).
// Shows the AD Users directory synced from Microsoft Entra: sync,
// search/filter, per-user access toggle, and role management via the
// details drawer. (Moved out of Settings; AD Users only.)

import { useTranslation } from "react-i18next";

import { AdUsersView } from "./AdUsersPage";

export function UsersPage() {
  const { t } = useTranslation();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          {t("userManagement.title")}
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          {t("userManagement.subtitle")}
        </p>
      </header>

      <AdUsersView />
    </div>
  );
}
