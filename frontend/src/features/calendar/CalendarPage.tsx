// Attendance Calendar page (P28.6).
//
// Two views:
//   - Company: tenant-wide month aggregate (Admin/HR/Manager)
//   - Per-person: one employee's month (Admin/HR/Manager pick;
//     Employee auto-locked to themselves).
// Click any day in either view to open the DayDetailDrawer.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMe } from "../../auth/AuthProvider";
import { primaryRole } from "../../types";
import { NewRequestDrawer } from "../../requests/NewRequestDrawer";
import { useAttendance } from "../attendance/hooks";
import { useMyEmployee } from "../employees/hooks";
import { CompanyView } from "./CompanyView";
import { DayDetailDrawer } from "./DayDetailDrawer";
import { PersonPickerGrid } from "./PersonPickerGrid";
import { PersonView } from "./PersonView";
import {
  useCompanyCalendar,
  usePersonCalendar,
} from "./hooks";

import { Icon } from "../../shell/Icon";

type Tab = "company" | "person";

export function CalendarPage() {
  const { t } = useTranslation();
  const me = useMe();
  const role = me.data ? primaryRole(me.data.roles) : "Employee";
  const isCompanyAllowed = role === "Admin" || role === "HR" || role === "Manager";

  // Admin/HR/Manager land on the Company view (org-wide month
  // aggregate) so they see the global picture before drilling in.
  // Employee can't see the Company tab — they stay on Person, locked
  // to themselves.
  const [tab, setTab] = useState<Tab>("company");
  const effectiveTab: Tab = isCompanyAllowed ? tab : "person";
  const [month, setMonth] = useState<string>(currentMonth());

  // Per-person picker state. The card-grid component (PersonPickerGrid)
  // owns its own search/department/page state — we only track the
  // *selected* employee id here.
  const [employeeId, setEmployeeId] = useState<number | null>(null);

  // When the operator drilled in from a Company-view day click, hold
  // onto the date here so we can fetch /api/attendance for that day
  // and narrow the picker grid to the OT check-ins on weekend/holiday
  // days. ``null`` means "show the full picker".
  const [pickedCompanyDate, setPickedCompanyDate] = useState<string | null>(
    null,
  );
  const pickedDayAttendance = useAttendance(pickedCompanyDate, null);
  const drillFilter = useMemo(() => {
    if (!pickedCompanyDate) return null;
    const items = pickedDayAttendance.data?.items ?? [];
    if (items.length === 0) return null;
    const sample = items[0]!;
    if (!sample.is_weekend && !sample.is_holiday) {
      // Working day — full picker is the right surface.
      return null;
    }
    const ids = items
      .filter((it) => Boolean(it.in_time))
      .map((it) => it.employee_id);
    return {
      date: pickedCompanyDate,
      kind: sample.is_holiday ? ("holiday" as const) : ("weekend" as const),
      holidayName: sample.holiday_name ?? null,
      employeeIds: ids,
    };
  }, [pickedCompanyDate, pickedDayAttendance.data]);

  // Auto-resolve the logged-in user once. The ref flips to true on the
  // first auto-fill or any explicit "go to picker" gesture (Back
  // button, Company-view day click), so we never override an operator
  // who's deliberately landed on the picker grid.
  const myEmployee = useMyEmployee();
  const autoFilledRef = useRef(false);
  useEffect(() => {
    if (autoFilledRef.current) return;
    if (employeeId !== null) return;
    if (!myEmployee.data) return;
    // Skip auto-fill for roles that default to Company view — the
    // first action there should drop them on the picker, not their
    // own calendar.
    if (isCompanyAllowed) {
      autoFilledRef.current = true;
      return;
    }
    setEmployeeId(myEmployee.data.id);
    autoFilledRef.current = true;
  }, [employeeId, myEmployee.data, isCompanyAllowed]);

  const company = useCompanyCalendar(
    month,
    effectiveTab === "company" && isCompanyAllowed,
  );
  const person = usePersonCalendar(
    effectiveTab === "person" ? employeeId : null,
    month,
  );

  const [drawerDate, setDrawerDate] = useState<string | null>(null);
  const [exceptionDate, setExceptionDate] = useState<string | null>(null);
  const drawerEmployeeId = effectiveTab === "person" ? employeeId : null;

  const onPickCompanyDate = (iso: string) => {
    // Drill from Company → Person picker for the same month. Clear
    // the selected employee and lock auto-fill so the operator lands
    // on the picker grid, not their own calendar.
    setMonth(iso.slice(0, 7));
    setEmployeeId(null);
    setPickedCompanyDate(iso);
    autoFilledRef.current = true;
    setTab("person");
  };

  const onPickPersonDay = (iso: string) => {
    setDrawerDate(iso);
  };

  const exportHref = useMemo(() => {
    const params = new URLSearchParams({ month });
    if (effectiveTab === "person" && employeeId !== null) {
      params.set("employee_id", String(employeeId));
    }
    return `/api/attendance/calendar/export?${params.toString()}`;
  }, [month, effectiveTab, employeeId]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("calendar.title") as string}
          </h1>
          <p className="page-sub">
            {effectiveTab === "company"
              ? (t("calendar.companySub") as string)
              : (t("calendar.personSub") as string)}
          </p>
        </div>
        <div
          className="page-actions"
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || currentMonth())}
            style={selectStyle}
            aria-label={t("calendar.month") as string}
          />
          <a
            className="btn"
            href={exportHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("calendar.exportMonth") as string}
          </a>
        </div>
      </div>

      {/* Tab strip */}
      {isCompanyAllowed && (
        <div
          style={{
            display: "flex",
            gap: 4,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            padding: 3,
            width: "fit-content",
            background: "var(--bg-elev)",
            marginBottom: 16,
          }}
        >
          <TabButton
            active={effectiveTab === "company"}
            onClick={() => setTab("company")}
          >
            {t("calendar.tabCompany") as string}
          </TabButton>
          <TabButton
            active={effectiveTab === "person"}
            onClick={() => setTab("person")}
          >
            {t("calendar.tabPerson") as string}
          </TabButton>
        </div>
      )}

      {/* Per-person tab now opens with a card grid. Operator picks
          a card → calendar loads. A back-to-list button at the top
          of the calendar card returns to the picker. */}
      {effectiveTab === "person" &&
        employeeId !== null &&
        role !== "Employee" && (
          <div style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setEmployeeId(null);
                setPickedCompanyDate(null);
                autoFilledRef.current = true;
              }}
            >
              <Icon name="chevronLeft" size={11} />
              {t("calendar.backToList", {
                defaultValue: "Back to employees",
              }) as string}
            </button>
          </div>
        )}

      {effectiveTab === "company" && isCompanyAllowed && (
        <>
          {company.isLoading && (
            <div className="text-sm text-dim">{t("calendar.loading") as string}</div>
          )}
          {company.isError && (
            <div className="text-sm" style={{ color: "var(--danger-text)" }}>
              {t("calendar.loadFailed") as string}
            </div>
          )}
          {company.data && (
            <CompanyView
              month={month}
              days={company.data.days}
              onPickDate={onPickCompanyDate}
            />
          )}
        </>
      )}

      {effectiveTab === "person" && (
        <>
          {employeeId === null && role !== "Employee" && (
            <PersonPickerGrid
              onPickEmployee={(emp) => setEmployeeId(emp.id)}
              restrictToIds={drillFilter ? drillFilter.employeeIds : null}
              restrictionLabel={
                drillFilter
                  ? drillFilter.kind === "holiday"
                    ? t("calendar.drill.holiday", {
                        date: drillFilter.date,
                        name: drillFilter.holidayName ?? "",
                        defaultValue: drillFilter.holidayName
                          ? `Holiday — ${drillFilter.holidayName} · ${drillFilter.date}`
                          : `Holiday · ${drillFilter.date}`,
                      }) as string
                    : (t("calendar.drill.weekend", {
                        date: drillFilter.date,
                        defaultValue: `Weekend · ${drillFilter.date}`,
                      }) as string)
                  : null
              }
              onClearRestriction={() => setPickedCompanyDate(null)}
            />
          )}
          {employeeId === null && role === "Employee" && (
            <div className="card" style={{ padding: 16 }}>
              <div className="text-sm text-dim">
                {t("calendar.pickEmployeeHint") as string}
              </div>
            </div>
          )}
          {employeeId !== null && person.isLoading && (
            <div className="text-sm text-dim">{t("calendar.loading") as string}</div>
          )}
          {employeeId !== null && person.isError && (
            <div className="text-sm" style={{ color: "var(--danger-text)" }}>
              {t("calendar.loadFailed") as string}
            </div>
          )}
          {employeeId !== null && person.data && (
            <PersonView person={person.data} onPickDay={onPickPersonDay} />
          )}
        </>
      )}

      {drawerEmployeeId !== null && drawerDate && (
        <DayDetailDrawer
          employeeId={drawerEmployeeId}
          isoDate={drawerDate}
          onClose={() => setDrawerDate(null)}
          onSubmitException={(iso) => {
            setExceptionDate(iso);
            setDrawerDate(null);
          }}
        />
      )}

      {exceptionDate && (
        <NewRequestDrawer
          initialType="exception"
          initialStartDate={exceptionDate}
          onClose={() => setExceptionDate(null)}
          onCreated={() => setExceptionDate(null)}
        />
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent-text)" : "var(--text)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        padding: "6px 14px",
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontSize: 12.5,
};
