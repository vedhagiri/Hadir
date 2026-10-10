// Settings → Notifications. Per-user category × channel grid.
// The attendance email toggles and delivery log are on Settings → Email.

import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { Icon } from "../shell/Icon";
import { useNotificationPreferences, usePatchPreference } from "./hooks";
import { SkeletonTable } from "../components/Skeleton";
import { EmptyPanel } from "../components/ListPageUi";
import { TableCard, WF_ICON, WfSvg, errorDetail } from "../requests/workflowUi";
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
      const msg = err instanceof ApiError ? err.message : t("common.errorGeneric");
      window.alert(msg);
    }
  };

  return (
    <div className="wf-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("notifications.preferences.title")}</h1>
          <p className="page-sub">{t("notifications.preferences.subtitle")}</p>
        </div>
      </div>

      {prefs.isLoading ? (
        <SkeletonTable rows={6} cols={3} />
      ) : prefs.error ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
            title={t("notifications.preferences.loadError", { defaultValue: "Couldn't load preferences" })}
            body={errorDetail(prefs.error, t("common.errorGeneric"))}
            actions={
              <button type="button" className="btn" onClick={() => void prefs.refetch()}>
                <Icon name="refresh" size={12} /> {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th>{t("notifications.preferences.category")}</th>
                <th className="wf-center wf-nowrap" style={{ width: 130 }}>
                  {t("notifications.preferences.inApp")}
                </th>
                <th className="wf-center wf-nowrap" style={{ width: 130 }}>
                  {t("notifications.preferences.email")}
                </th>
              </tr>
            </thead>
            <tbody>
              {ALL_CATEGORIES.map((c) => {
                const p = byCat.get(c);
                const inApp = p?.in_app ?? true;
                const email = p?.email ?? true;
                const label = t(`notifications.categories.${c}`, { defaultValue: c });
                return (
                  <tr key={c}>
                    <td>
                      <div className="wf-primary-name">{label}</div>
                      <div className="wf-sub">
                        {t(`notifications.preferences.hint.${c}`, { defaultValue: HINT[c] })}
                      </div>
                    </td>
                    <td className="wf-center">
                      <ToggleSwitch
                        checked={inApp}
                        onChange={(next) => void onToggle(c, "in_app", next)}
                        disabled={patch.isPending}
                        label={`${t("notifications.preferences.inApp")}: ${label}`}
                      />
                    </td>
                    <td className="wf-center">
                      <ToggleSwitch
                        checked={email}
                        onChange={(next) => void onToggle(c, "email", next)}
                        disabled={patch.isPending}
                        label={`${t("notifications.preferences.email")}: ${label}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  );
}

const HINT: Record<NotificationCategory, string> = {
  approval_assigned: "A request is waiting for your decision.",
  approval_decided: "One of your requests was approved or rejected.",
  overtime_flagged: "Overtime was recorded for you or your team.",
  camera_unreachable: "A camera has been offline for more than 5 minutes.",
  report_ready: "A report you generated is ready to download.",
  admin_override: "An administrator overrode a request decision.",
};

/** Accessible on/off switch (native checkbox underneath for keyboard + AT). */
function ToggleSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <label className={`wf-switch${disabled ? " is-disabled" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        aria-label={label}
      />
      <span aria-hidden className="wf-switch-track" />
      <span aria-hidden className="wf-switch-thumb" />
    </label>
  );
}
