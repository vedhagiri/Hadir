// Right-sliding drawer for one row on the Daily Attendance page.
// Renders the exact same DayDetailContent used by the Attendance Calendar
// and the Employee Profile Attendance tab — single source of truth for the
// Day Detail UI across all three surfaces.

import { useTranslation } from "react-i18next";

import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { DayDetailContent } from "../calendar/DayDetailDrawer";
import type { AttendanceItem } from "./types";

interface Props {
  item: AttendanceItem;
  onClose: () => void;
}

export function AttendanceDrawer({ item, onClose }: Props) {
  const { t } = useTranslation();

  const exportHref =
    `/api/attendance/calendar/export?month=${item.date.slice(0, 7)}` +
    `&employee_id=${item.employee_id}&date=${item.date}`;

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
