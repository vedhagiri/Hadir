// Right-sliding drawer for one row on the Daily Attendance page.
// Renders the exact same DayDetailContent used by the Attendance Calendar
// and the Employee Profile Attendance tab — single source of truth for the
// Day Detail UI across all three surfaces.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { DayDetailContent } from "../calendar/DayDetailDrawer";
import { useRegenerateAttendanceForEmployee } from "./hooks";
import type { AttendanceItem } from "./types";

interface Props {
  item: AttendanceItem;
  onClose: () => void;
}

export function AttendanceDrawer({ item, onClose }: Props) {
  const { t } = useTranslation();
  const regen = useRegenerateAttendanceForEmployee();
  const [regenInfo, setRegenInfo] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);

  const exportHref =
    `/api/attendance/calendar/export?month=${item.date.slice(0, 7)}` +
    `&employee_id=${item.employee_id}&date=${item.date}`;

  const triggerRegen = () => {
    setRegenInfo(null);
    regen.mutate(
      { employee_id: item.employee_id, target_date: item.date },
      {
        onSuccess: (resp) => {
          setRegenInfo({
            tone: "ok",
            text: resp.upserted
              ? (t("attendance.regenOk", {
                  defaultValue: "Refreshed attendance for {{date}}.",
                  date: resp.date,
                }) as string)
              : (t("attendance.regenNoPolicy", {
                  defaultValue: "No policy resolves for {{date}} — nothing to refresh.",
                  date: resp.date,
                }) as string),
          });
        },
        onError: (err) => {
          setRegenInfo({
            tone: "err",
            text: (t("attendance.regenFailed", {
              defaultValue: "Regenerate failed: {{reason}}",
              reason: extractApiError(err, "request failed"),
            }) as string),
          });
        },
      },
    );
  };

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="text-xs text-dim">
              {t("calendar.dayDetail", { defaultValue: "Day detail" }) as string}
            </div>
            <div className="drawer-title" style={{ fontSize: 16, marginTop: 2 }}>
              {item.full_name} · <span className="mono">{item.date}</span>
            </div>
          </div>
          <div className="at-card-head-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={triggerRegen}
              disabled={regen.isPending}
              title={
                t("attendance.regenTooltip", {
                  defaultValue:
                    "Recompute this row from current camera events",
                }) as string
              }
            >
              <Icon name="refresh" size={12} />
              {regen.isPending
                ? (t("attendance.regenerating", {
                    defaultValue: "Regenerating…",
                  }) as string)
                : (t("attendance.regenFromEvents", {
                    defaultValue: "Regenerate",
                  }) as string)}
            </button>
            <a
              className="btn btn-sm"
              href={exportHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="download" size={12} />
              {t("calendar.export", { defaultValue: "Export" }) as string}
            </a>
            <button
              className="icon-btn"
              onClick={onClose}
              aria-label={t("common.close", { defaultValue: "Close" }) as string}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {regenInfo && (
          <div
            className={`at-notice tone-${regenInfo.tone === "ok" ? "info" : "danger"}`}
            role="status"
            style={{ margin: "12px 24px 0" }}
          >
            <span className="at-notice-text">{regenInfo.text}</span>
            <button
              type="button"
              className="at-notice-close"
              onClick={() => setRegenInfo(null)}
              aria-label={t("common.close", { defaultValue: "Close" }) as string}
            >
              ×
            </button>
          </div>
        )}

        <div className="drawer-body">
          <DayDetailContent
            employeeId={item.employee_id}
            isoDate={item.date}
          />
        </div>
      </div>
    </DrawerShell>
  );
}
