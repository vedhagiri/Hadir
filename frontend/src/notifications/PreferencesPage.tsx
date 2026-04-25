// Settings → Notifications. Per-user category × channel grid.

import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { SettingsTabs } from "../settings/SettingsTabs";
import {
  useNotificationPreferences,
  usePatchPreference,
} from "./hooks";
import {
  ALL_CATEGORIES,
  type NotificationCategory,
  type NotificationPreference,
} from "./types";


export function NotificationPreferencesPage() {
  const { t } = useTranslation();
  const prefs = useNotificationPreferences();
  const patch = usePatchPreference();

  const items: NotificationPreference[] = prefs.data?.items ?? [];
  const byCat = new Map(items.map((p) => [p.category, p]));

  const onToggle = async (
    category: NotificationCategory,
    field: "in_app" | "email",
    next: boolean,
  ) => {
    const current = byCat.get(category);
    if (!current) return;
    const body = {
      category,
      in_app: field === "in_app" ? next : current.in_app,
      email: field === "email" ? next : current.email,
    };
    try {
      await patch.mutateAsync(body);
    } catch (err) {
      // Surface the failure inline; keep the UI calm — TanStack
      // Query rolls back on error.
      const msg = err instanceof ApiError ? err.message : "Save failed.";
      window.alert(msg);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsTabs />
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          {t("notifications.preferences.title")}
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          {t("notifications.preferences.subtitle")}
        </p>
      </header>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>{t("notifications.preferences.category")}</th>
              <th style={{ width: 100, textAlign: "center" }}>
                {t("notifications.preferences.inApp")}
              </th>
              <th style={{ width: 100, textAlign: "center" }}>
                {t("notifications.preferences.email")}
              </th>
            </tr>
          </thead>
          <tbody>
            {ALL_CATEGORIES.map((c) => {
              const p = byCat.get(c);
              const inApp = p?.in_app ?? true;
              const email = p?.email ?? true;
              const label = t(`notifications.categories.${c}`, {
                defaultValue: c,
              });
              return (
                <tr key={c}>
                  <td>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
                    <div className="text-xs text-dim mono">{c}</div>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={inApp}
                      onChange={(e) =>
                        void onToggle(c, "in_app", e.target.checked)
                      }
                      disabled={patch.isPending}
                      aria-label={`${t("notifications.preferences.inApp")}: ${label}`}
                    />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={email}
                      onChange={(e) =>
                        void onToggle(c, "email", e.target.checked)
                      }
                      disabled={patch.isPending}
                      aria-label={`${t("notifications.preferences.email")}: ${label}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
