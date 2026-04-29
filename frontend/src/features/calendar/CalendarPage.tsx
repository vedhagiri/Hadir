// Attendance Calendar page (P28.6).
//
// Two views:
//   - Company: tenant-wide month aggregate (Admin/HR/Manager)
//   - Per-person: one employee's month (Admin/HR/Manager pick;
//     Employee auto-locked to themselves).
// Click any day in either view to open the DayDetailDrawer.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMe } from "../../auth/AuthProvider";
import { primaryRole } from "../../types";
import { NewRequestDrawer } from "../../requests/NewRequestDrawer";
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

  // Default to Per-person view scoped to the logged-in user. Admin/HR/
  // Manager can still flip to the Company tab; Employee never sees the
  // tab strip. This puts "my own calendar" in front of every role on
  // first load, mirroring the My Attendance page's self-view.
  const [tab, setTab] = useState<Tab>("person");
  const [month, setMonth] = useState<string>(currentMonth());

  // Per-person picker state. The card-grid component (PersonPickerGrid)
  // owns its own search/department/page state — we only track the
  // *selected* employee id here.
  const [employeeId, setEmployeeId] = useState<number | null>(null);

  // Auto-resolve the logged-in user to themselves for every role —
  // Admin/HR/Manager get their own calendar pre-loaded; the picker
  // stays one click away via the "Back to employees" button. The
  // backend's GET /api/employees/me does the email match server-side
  // so we don't ship the entire employee list to the client.
  const myEmployee = useMyEmployee();
  useEffect(() => {
    if (employeeId !== null) return;
    if (myEmployee.data) setEmployeeId(myEmployee.data.id);
  }, [employeeId, myEmployee.data]);

  const company = useCompanyCalendar(
    month,
    tab === "company" && isCompanyAllowed,
  );
  const person = usePersonCalendar(
    tab === "person" ? employeeId : null,
    month,
  );

  const [drawerDate, setDrawerDate] = useState<string | null>(null);
  const [exceptionDate, setExceptionDate] = useState<string | null>(null);
  const drawerEmployeeId =
    tab === "person" ? employeeId : drawerEmployeeForCompany();

  // For Company tab: drilling into a date without a fixed employee
  // doesn't open the per-person drawer — instead we drop the user
  // into Per-person view scoped to that date for picking. Per the
  // prompt: company view click → "Per-person view, scoped to that
  // date". Until they pick an employee the drawer stays closed.
  function drawerEmployeeForCompany(): number | null {
    return null;
  }

  const onPickCompanyDate = (iso: string) => {
    setTab("person");
    // No automatic drawer open — they pick an employee, then click a
    // day to drill in. This mirrors the prompt's UX expectation
    // ("Per-person view, scoped to that date") without forcing a
    // pre-selection that may not be the operator's first choice.
    setMonth(iso.slice(0, 7));
  };

  const onPickPersonDay = (iso: string) => {
    setDrawerDate(iso);
  };

  const exportHref = useMemo(() => {
    const params = new URLSearchParams({ month });
    if (tab === "person" && employeeId !== null) {
      params.set("employee_id", String(employeeId));
    }
    return `/api/attendance/calendar/export?${params.toString()}`;
  }, [month, tab, employeeId]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("calendar.title") as string}
          </h1>
          <p className="page-sub">
            {tab === "company"
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
            active={tab === "company"}
            onClick={() => setTab("company")}
          >
            {t("calendar.tabCompany") as string}
          </TabButton>
          <TabButton
            active={tab === "person"}
            onClick={() => setTab("person")}
          >
            {t("calendar.tabPerson") as string}
          </TabButton>
        </div>
      )}

      {/* Per-person tab now opens with a card grid. Operator picks
          a card → calendar loads. A back-to-list button at the top
          of the calendar card returns to the picker. */}
      {tab === "person" &&
        employeeId !== null &&
        role !== "Employee" && (
          <div style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setEmployeeId(null)}
            >
              <Icon name="chevronLeft" size={11} />
              {t("calendar.backToList", {
                defaultValue: "Back to employees",
              }) as string}
            </button>
          </div>
        )}

      {tab === "company" && isCompanyAllowed && (
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

      {tab === "person" && (
        <>
          {employeeId === null && role !== "Employee" && (
            <PersonPickerGrid
              onPickEmployee={(emp) => setEmployeeId(emp.id)}
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
