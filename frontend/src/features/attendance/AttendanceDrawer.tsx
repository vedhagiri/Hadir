// Right-sliding drawer for one row on the Daily Attendance page.
// Renders the exact same DayDetailContent used by the Attendance Calendar
// and the Employee Profile Attendance tab — single source of truth for the
// Day Detail UI across all three surfaces.

import { useState } from "react";
import { useTranslation } from "react-i18next";

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
              reason: (err as Error).message,
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
            <div className="mono text-xs text-dim">
              {t("calendar.dayDetail", { defaultValue: "Day detail" }) as string}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {item.full_name} · {item.date}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
              <span aria-hidden style={{ marginInlineEnd: 4 }}>↻</span>
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
            style={{
              margin: "8px 16px 0",
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 12.5,
              background:
                regenInfo.tone === "ok"
                  ? "var(--info-soft, var(--bg-sunken))"
                  : "var(--danger-soft, var(--bg-sunken))",
              border:
                regenInfo.tone === "ok"
                  ? "1px solid var(--info, var(--border))"
                  : "1px solid var(--danger, var(--border))",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span>{regenInfo.text}</span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: "2px 8px", fontSize: 11 }}
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
