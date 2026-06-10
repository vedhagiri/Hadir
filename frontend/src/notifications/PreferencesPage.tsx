// Settings → Notifications. Per-user category × channel grid, plus the
// Admin-only tenant-wide attendance email toggles + delivery log (0080).

import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { useMe } from "../auth/AuthProvider";
import { SettingsTabs } from "../settings/SettingsTabs";
import {
  useAttendanceEmailConfig,
  useAttendanceEmailLog,
  useNotificationPreferences,
  usePatchPreference,
  usePutAttendanceEmailConfig,
} from "./hooks";
import {
  ALL_CATEGORIES,
  type AttendanceEmailConfig,
  type AttendanceEmailLogItem,
  type AttendanceEmailStatus,
  type NotificationCategory,
  type NotificationPreference,
} from "./types";


const ATT_STATUSES: AttendanceEmailStatus[] = ["present", "late", "absent"];

function logOutcome(item: AttendanceEmailLogItem): {
  key: "sent" | "failed" | "skipped" | "pending";
  tone: string;
} {
  if (item.sent_at) return { key: "sent", tone: "var(--success, #0a8a52)" };
  if (item.skipped_at)
    return { key: "skipped", tone: "var(--text-secondary)" };
  if (item.failed_at)
    return { key: "failed", tone: "var(--danger, #b91c1c)" };
  return { key: "pending", tone: "var(--text-secondary)" };
}


function AttendanceEmailCard() {
  const { t } = useTranslation();
  const config = useAttendanceEmailConfig(true);
  const putConfig = usePutAttendanceEmailConfig();
  const log = useAttendanceEmailLog(true);

  const current: AttendanceEmailConfig = config.data ?? {
    present: false,
    late: false,
    absent: false,
  };

  const onToggle = async (status: AttendanceEmailStatus, next: boolean) => {
    try {
      await putConfig.mutateAsync({ ...current, [status]: next });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Save failed.";
      window.alert(msg);
    }
  };

  const items = log.data?.items ?? [];

  return (
    <div className="card">
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          {t("notifications.attendanceEmail.title")}
        </div>
        <p
          style={{
            margin: "4px 0 0 0",
            color: "var(--text-secondary)",
            fontSize: 13,
          }}
        >
          {t("notifications.attendanceEmail.subtitle")}
        </p>
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {ATT_STATUSES.map((s) => (
          <label
            key={s}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={current[s]}
              onChange={(e) => void onToggle(s, e.target.checked)}
              disabled={config.isLoading || putConfig.isPending}
              aria-label={t(`notifications.attendanceEmail.${s}`)}
            />
            {t(`notifications.attendanceEmail.${s}`)}
          </label>
        ))}
      </div>

      <div
        style={{
          margin: "14px 0 10px 0",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {t("notifications.attendanceEmail.logTitle")}
      </div>
      {items.length === 0 ? (
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          {t("notifications.attendanceEmail.logEmpty")}
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t("notifications.attendanceEmail.colEmployee")}</th>
              <th>{t("notifications.attendanceEmail.colDate")}</th>
              <th>{t("notifications.attendanceEmail.colStatus")}</th>
              <th>{t("notifications.attendanceEmail.colRecipient")}</th>
              <th>{t("notifications.attendanceEmail.colDelivery")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const outcome = logOutcome(item);
              return (
                <tr key={item.id}>
                  <td>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {item.employee_name}
                    </div>
                    <div className="text-xs text-dim mono">
                      {item.employee_code}
                    </div>
                  </td>
                  <td style={{ fontSize: 13 }}>{item.date}</td>
                  <td style={{ fontSize: 13 }}>
                    {t(`notifications.attendanceEmail.${item.status}Short`, {
                      defaultValue: item.status,
                    })}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {item.recipient_email ?? "—"}
                    {item.recipient_kind === "manager" && (
                      <span
                        className="pill pill-neutral"
                        style={{ fontSize: 10, marginInlineStart: 6 }}
                      >
                        {t("notifications.attendanceEmail.managerCopy")}
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: outcome.tone,
                      }}
                      title={item.last_error ?? undefined}
                    >
                      {t(`notifications.attendanceEmail.outcome.${outcome.key}`)}
                      {item.attempts > 1 ? ` (×${item.attempts})` : ""}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}


export function NotificationPreferencesPage() {
  const { t } = useTranslation();
  const me = useMe();
  const isAdmin = me.data?.active_role === "Admin";
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

      {isAdmin ? <AttendanceEmailCard /> : null}

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
