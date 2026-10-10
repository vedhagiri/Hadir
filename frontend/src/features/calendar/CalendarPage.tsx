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
import { useEmployeeDetail, useMyEmployee } from "../employees/hooks";
import { CompanyView } from "./CompanyView";
import { DayDetailDrawer } from "./DayDetailDrawer";
import { PersonPickerGrid } from "./PersonPickerGrid";
import { PersonView } from "./PersonView";
import { MonthNav, ProfileHeader, SummaryStrip, shiftMonth } from "./calendarUi";
import type { SummaryCounts } from "./calendarUi";
import type { CompanyDay, PersonDay } from "./types";
import {
  useCompanyCalendar,
  usePersonCalendar,
} from "./hooks";

import { Icon } from "../../shell/Icon";
import { EmptyPanel } from "../../components/ListPageUi";
import { SkeletonCalendar } from "../../components/Skeleton";
import { AlertGlyph } from "../cameras/coreUi";
import { extractApiError } from "../../api/client";

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
  // Previous month — feeds the "change vs last month" on the summary.
  const prevMonth = shiftMonth(month, -1);
  const companyPrev = useCompanyCalendar(
    prevMonth,
    effectiveTab === "company" && isCompanyAllowed,
  );
  const personPrev = usePersonCalendar(
    effectiveTab === "person" ? employeeId : null,
    prevMonth,
  );
  // Profile card data. Employees read their own record via /me; other
  // roles fetch the picked employee (a 403 just leaves the card with
  // name + code from the calendar payload).
  const pickedEmployee = useEmployeeDetail(
    effectiveTab === "person" && role !== "Employee" ? employeeId : null,
  );
  const profileEmployee = role === "Employee" ? myEmployee.data : pickedEmployee.data;

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

  const personSelected = effectiveTab === "person" && employeeId !== null;

  const exportButton = (
    <a className="btn" href={exportHref} target="_blank" rel="noopener noreferrer">
      <Icon name="download" size={14} />
      {t("calendar.exportMonth") as string}
    </a>
  );

  return (
    <>
      {personSelected ? (
        <>
          {role !== "Employee" && (
            <button
              type="button"
              onClick={() => {
                setEmployeeId(null);
                setPickedCompanyDate(null);
                autoFilledRef.current = true;
              }}
              className="co-back"
            >
              <span aria-hidden className="icon-chevron-left" style={{ display: "inline-flex" }}><Icon name="chevronLeft" size={14} /></span>
              {t("calendar.backToList", { defaultValue: "Back to employees" }) as string}
            </button>
          )}
          <ProfileHeader
            fullName={person.data?.full_name ?? profileEmployee?.full_name ?? ""}
            employeeCode={person.data?.employee_code ?? profileEmployee?.employee_code ?? ""}
            employee={profileEmployee}
          />
          <div className="page-header" style={{ marginBottom: 14 }}>
            <div>
              <h2 className="page-title" style={{ fontSize: 22 }}>{t("calendar.title") as string}</h2>
              <p className="page-sub">
                {t("calendar.personDetailSub", {
                  defaultValue: "View daily attendance details for the selected employee",
                }) as string}
              </p>
            </div>
            <div className="page-actions">
              <MonthNav month={month} onChange={setMonth} />
              {exportButton}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="page-header">
            <div>
              <h1 className="page-title">{t("calendar.title") as string}</h1>
              <p className="page-sub">
                {effectiveTab === "company"
                  ? (t("calendar.companySub") as string)
                  : (t("calendar.personSub") as string)}
              </p>
            </div>
            <div className="page-actions">
              <MonthNav month={month} onChange={setMonth} />
              {exportButton}
            </div>
          </div>

          {isCompanyAllowed && (
            <div role="group" aria-label={t("calendar.title") as string} className="seg co-seg" style={{ display: "inline-flex" }}>
              <TabButton active={effectiveTab === "company"} onClick={() => setTab("company")}>
                {t("calendar.tabCompany") as string}
              </TabButton>
              <TabButton active={effectiveTab === "person"} onClick={() => setTab("person")}>
                {t("calendar.tabPerson") as string}
              </TabButton>
            </div>
          )}
        </>
      )}

      {effectiveTab === "company" && isCompanyAllowed && (
        <>
          {company.isLoading && (
            <SkeletonCalendar />
          )}
          {company.isError && (
            <div className="card">
              <EmptyPanel
                tone="danger"
                icon={<AlertGlyph />}
                title={t("calendar.loadFailed") as string}
                body={extractApiError(company.error, "")}
                actions={
                  <button type="button" className="btn" onClick={() => void company.refetch()}>
                    <Icon name="refresh" size={12} />
                    {t("common.retry", { defaultValue: "Retry" })}
                  </button>
                }
              />
            </div>
          )}
          {company.data && (
            <SummaryStrip
              counts={companyCounts(company.data.days)}
              previous={companyPrev.data ? companyCounts(companyPrev.data.days) : null}
            />
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
            <SkeletonCalendar />
          )}
          {employeeId !== null && person.isError && (
            <div className="card">
              <EmptyPanel
                tone="danger"
                icon={<AlertGlyph />}
                title={t("calendar.loadFailed") as string}
                body={extractApiError(person.error, "")}
                actions={
                  <button type="button" className="btn" onClick={() => void person.refetch()}>
                    <Icon name="refresh" size={12} />
                    {t("common.retry", { defaultValue: "Retry" })}
                  </button>
                }
              />
            </div>
          )}
          {employeeId !== null && person.data && (
            <>
              <SummaryStrip
                counts={personCounts(person.data.days)}
                previous={personPrev.data ? personCounts(personPrev.data.days) : null}
              />
              <PersonView person={person.data} onPickDay={onPickPersonDay} hideHeader />
            </>
          )}
        </>
      )}

      {drawerEmployeeId !== null && drawerDate && (
        <DayDetailDrawer
          employeeId={drawerEmployeeId}
          isoDate={drawerDate}
          onClose={() => setDrawerDate(null)}
          {...(role !== "Admin" && {
            onSubmitException: (iso: string) => {
              setExceptionDate(iso);
              setDrawerDate(null);
            },
          })}
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
    <button type="button" onClick={onClick} aria-pressed={active} className={`seg-btn${active ? " active" : ""}`} style={{ padding: "0 22px" }}>
      {children}
    </button>
  );
}

/** Company summary: employee-day totals for the month; holiday and
 *  weekend are counts of calendar days. */
function companyCounts(days: CompanyDay[]): SummaryCounts {
  return {
    present: days.reduce((a, d) => a + d.present_count, 0),
    late: days.reduce((a, d) => a + d.late_count, 0),
    absent: days.reduce((a, d) => a + d.absent_count, 0),
    leave: days.reduce((a, d) => a + d.leave_count, 0),
    holiday: days.filter((d) => d.is_holiday).length,
    weekend: days.filter((d) => d.is_weekend).length,
  };
}

/** Per-person summary: number of days in each state. */
function personCounts(days: PersonDay[]): SummaryCounts {
  return {
    present: days.filter((d) => d.status === "present" || d.status === "escalation_present" || (d.status === "weekend" && !!d.in_time)).length,
    late: days.filter((d) => d.status === "late").length,
    absent: days.filter((d) => d.status === "absent").length,
    leave: days.filter((d) => d.status === "leave").length,
    holiday: days.filter((d) => d.status === "holiday" || d.is_holiday).length,
    weekend: days.filter((d) => d.is_weekend || d.status === "weekend").length,
  };
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

