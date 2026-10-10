// Manager dashboard ("Team Today") — scoped to the manager's own team.
// Backend enforces the scope: GET /api/attendance and the company
// calendar return rows only for employees the manager can see (P8
// union of department membership + direct assignments). Frontend never
// widens.
//
// Layout: greeting → today's team tiles (click to filter the roster) →
// month attendance trend | needs-your-attention lists → team roster.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useMe } from "../../auth/AuthProvider";
import { SkeletonCards, SkeletonChart, SkeletonLines, SkeletonRows } from "../../components/Skeleton";
import { useInboxSummary } from "../../requests/hooks";
import { Icon } from "../../shell/Icon";
import { useAttendance } from "../attendance/hooks";
import { formatMinutes } from "../attendance/timeFormat";
import type { AttendanceItem } from "../attendance/types";
import { useCompanyCalendar } from "../calendar/hooks";
import type { CompanyDay } from "../calendar/types";
import { avatarBg, initials } from "../employees/EmployeesPage";
import { Panel, PanelEmpty, PanelError, Tile, TileGrid, clockTime, firstName, nowrap } from "./DashUi";

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Status = "present" | "late" | "absent" | "waiting" | "leave" | "weekend" | "holiday";
type Filter = "" | "present" | "late" | "absent" | "leave" | "waiting";

/** One status per row, in the same precedence the calendar uses. */
function statusOf(it: AttendanceItem): Status {
  if (it.leave_type_id != null) return "leave";
  if (it.is_holiday && !it.in_time) return "holiday";
  if (it.is_weekend && !it.in_time) return "weekend";
  if (it.pending) return "waiting";
  if (it.absent) return "absent";
  if (it.late) return "late";
  return "present";
}

const PILL: Record<Status, string> = {
  present: "pill-success",
  late: "pill-warning",
  absent: "pill-danger",
  waiting: "pill-info",
  leave: "pill-accent",
  weekend: "pill-neutral",
  holiday: "pill-neutral",
};

export function ManagerDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  const now = new Date();
  const todayIso = isoDate(now);
  const month = todayIso.slice(0, 7);

  const today = useAttendance(todayIso, null);
  const monthCal = useCompanyCalendar(month);
  const inbox = useInboxSummary();
  const [filter, setFilter] = useState<Filter>("");

  const statusLabel: Record<Status, string> = {
    present: t("dashboard.manager.status.present", { defaultValue: "Present" }),
    late: t("dashboard.manager.status.late", { defaultValue: "Late" }),
    absent: t("dashboard.manager.status.absent", { defaultValue: "Absent" }),
    waiting: t("dashboard.manager.status.waiting", { defaultValue: "Not in yet" }),
    leave: t("dashboard.manager.status.leave", { defaultValue: "On leave" }),
    weekend: t("dashboard.manager.status.weekend", { defaultValue: "Week off" }),
    holiday: t("dashboard.manager.status.holiday", { defaultValue: "Holiday" }),
  };

  const items = today.data?.items ?? [];
  const withStatus = useMemo(() => items.map((it) => ({ it, s: statusOf(it) })), [items]);

  const count = (s: Status) => withStatus.filter((r) => r.s === s).length;
  const present = count("present") + count("late");
  const lateRows = withStatus.filter((r) => r.s === "late").map((r) => r.it).sort((a, b) => (a.in_time ?? "").localeCompare(b.in_time ?? ""));
  const absentRows = withStatus.filter((r) => r.s === "absent").map((r) => r.it);
  const waitingRows = withStatus.filter((r) => r.s === "waiting").map((r) => r.it);
  const overtimeToday = items.reduce((sum, it) => sum + (it.overtime_minutes || 0), 0);
  const expected = withStatus.filter((r) => r.s !== "weekend" && r.s !== "holiday" && r.s !== "leave").length;

  const rows = useMemo(() => {
    if (!filter) return withStatus;
    if (filter === "present") return withStatus.filter((r) => r.s === "present" || r.s === "late");
    return withStatus.filter((r) => r.s === filter);
  }, [withStatus, filter]);

  const toggle = (f: Filter) => setFilter((cur) => (cur === f ? "" : f));
  const noDepartments = me.data != null && me.data.departments.length === 0;
  const pendingApprovals = inbox.data?.pending_count ?? 0;
  const breached = inbox.data?.breached_count ?? 0;

  const dateLabel = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data
              ? t("dashboard.manager.greeting", { name: firstName(me.data.full_name) })
              : t("dashboard.manager.title")}
          </h1>
          <p className="page-sub">
            {t("dashboard.manager.subtitleToday", {
              defaultValue: "{{date}} · your team's attendance, approvals and trends at a glance",
              date: dateLabel,
            })}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => navigate("/calendar")}>
            <Icon name="calendar" size={13} />
            {t("dashboard.manager.openCalendar", { defaultValue: "Team calendar" })}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => navigate("/team-attendance")}>
            <Icon name="users" size={13} />
            {t("dashboard.manager.openTeamAttendance", { defaultValue: "Team attendance" })}
          </button>
        </div>
      </div>

      {noDepartments && (
        <div className="card dsh-notice" role="status">
          {t("dashboard.manager.noDepartments")}
        </div>
      )}

      {/* ---- Today's team ------------------------------------------- */}
      {today.isLoading ? (
        <div style={{ marginBottom: 20 }}>
          <SkeletonCards count={5} minWidth={180} />
        </div>
      ) : (
        <TileGrid>
          <Tile
            tone="success"
            icon="check"
            label={t("dashboard.manager.tile.present", { defaultValue: "Present" })}
            value={
              <>
                {present}
                <span className="mgr-of"> / {expected}</span>
              </>
            }
            sub={
              expected > 0
                ? t("dashboard.manager.tile.presentSub", {
                    defaultValue: "{{pct}}% of today's expected team",
                    pct: Math.round((present / expected) * 100),
                  })
                : t("dashboard.manager.tile.nobodyExpected", { defaultValue: "Nobody expected today" })
            }
            onClick={() => toggle("present")}
            active={filter === "present"}
          />
          <Tile
            tone="warning"
            icon="clock"
            label={t("dashboard.manager.tile.late", { defaultValue: "Late" })}
            value={lateRows.length}
            sub={t("dashboard.manager.tile.lateSub", { defaultValue: "Arrived after the grace period" })}
            onClick={() => toggle("late")}
            active={filter === "late"}
          />
          <Tile
            tone="danger"
            icon="user"
            label={t("dashboard.manager.tile.absent", { defaultValue: "Absent" })}
            value={absentRows.length}
            sub={
              waitingRows.length > 0
                ? t("dashboard.manager.tile.absentSubWaiting", {
                    defaultValue: "+{{n}} not in yet (shift still open)",
                    n: waitingRows.length,
                  })
                : t("dashboard.manager.tile.absentSub", { defaultValue: "No detection, no approved leave" })
            }
            onClick={() => toggle("absent")}
            active={filter === "absent"}
          />
          <Tile
            tone="info"
            icon="calendar"
            label={t("dashboard.manager.tile.leave", { defaultValue: "On leave" })}
            value={count("leave")}
            sub={t("dashboard.manager.tile.leaveSub", { defaultValue: "Approved leave today" })}
            onClick={() => toggle("leave")}
            active={filter === "leave"}
          />
          <Tile
            tone={breached > 0 ? "danger" : "accent"}
            icon="inbox"
            label={t("dashboard.manager.tile.approvals", { defaultValue: "Waiting for you" })}
            value={pendingApprovals}
            sub={
              breached > 0
                ? t("dashboard.manager.tile.approvalsBreached", {
                    defaultValue: "{{n}} past the response time",
                    n: breached,
                  })
                : t("dashboard.manager.tile.approvalsSub", { defaultValue: "Requests to approve" })
            }
            onClick={() => navigate("/approvals")}
          />
        </TileGrid>
      )}

      {/* ---- Trend | attention --------------------------------------- */}
      <div className="dsh-row-2">
        <MonthTrend
          days={monthCal.data?.days ?? null}
          loading={monthCal.isLoading}
          error={monthCal.isError}
          onRetry={() => void monthCal.refetch()}
          todayIso={todayIso}
          overtimeToday={overtimeToday}
        />

        <Panel
          title={t("dashboard.manager.attentionTitle", { defaultValue: "Needs your attention" })}
          sub={t("dashboard.manager.attentionSub", { defaultValue: "Today, as of now" })}
        >
          {today.isLoading ? (
            <SkeletonLines lines={6} />
          ) : today.isError ? (
            <PanelError
              title={t("dashboard.manager.loadFailed", { defaultValue: "Couldn't load today's attendance" })}
              body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
              retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
              onRetry={() => void today.refetch()}
            />
          ) : lateRows.length + absentRows.length + waitingRows.length === 0 ? (
            <PanelEmpty
              tone="success"
              icon="check"
              title={t("dashboard.manager.allGood", { defaultValue: "All good today" })}
              body={t("dashboard.manager.allGoodBody", { defaultValue: "Nobody is late or missing right now." })}
            />
          ) : (
            <div className="mgr-attn">
              <AttentionList
                tone="warning"
                title={statusLabel.late}
                rows={lateRows}
                detail={(it) => t("dashboard.manager.inAt", { defaultValue: "In {{time}}", time: clockTime(it.in_time) })}
                onOpen={(id) => navigate(`/employees/${id}`)}
                onMore={() => navigate("/team-attendance")}
              />
              <AttentionList
                tone="danger"
                title={statusLabel.absent}
                rows={absentRows}
                detail={(it) => it.department.name}
                onOpen={(id) => navigate(`/employees/${id}`)}
                onMore={() => navigate("/team-attendance")}
              />
              <AttentionList
                tone="info"
                title={statusLabel.waiting}
                rows={waitingRows}
                detail={(it) => it.policy?.name ?? ""}
                onOpen={(id) => navigate(`/employees/${id}`)}
                onMore={() => navigate("/team-attendance")}
              />
            </div>
          )}
        </Panel>
      </div>

      {/* ---- Team roster --------------------------------------------- */}
      <Panel
        title={t("dashboard.manager.rosterTitle")}
        sub={
          today.data
            ? filter
              ? t("dashboard.manager.filteredCount", {
                  defaultValue: "{{shown}} of {{total}} · {{filter}}",
                  shown: rows.length,
                  total: items.length,
                  filter: statusLabel[filter],
                })
              : t("dashboard.manager.recordCount", { count: items.length })
            : ""
        }
        bodyPadding={0}
        actions={
          filter ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter("")}>
              {t("dashboard.manager.clearFilter", { defaultValue: "Clear filter" })}
            </button>
          ) : undefined
        }
      >
        {today.isError ? (
          <PanelError
            title={t("dashboard.manager.loadFailed", { defaultValue: "Couldn't load today's attendance" })}
            body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
            retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
            onRetry={() => void today.refetch()}
          />
        ) : today.data && rows.length === 0 ? (
          filter ? (
            <PanelEmpty
              icon="filter"
              title={t("dashboard.manager.noMatchTitle", { defaultValue: "Nobody in this group" })}
              body={t("dashboard.manager.noMatchBody", {
                defaultValue: "No team member is marked “{{filter}}” today.",
                filter: statusLabel[filter],
              })}
              action={
                <button type="button" className="btn btn-sm" onClick={() => setFilter("")}>
                  {t("dashboard.manager.clearFilter", { defaultValue: "Clear filter" })}
                </button>
              }
            />
          ) : (
            <PanelEmpty
              tone="accent"
              icon="users"
              title={t("dashboard.manager.emptyTitle", { defaultValue: "No records yet today" })}
              body={t("dashboard.manager.empty")}
            />
          )
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("dashboard.manager.cols.employee")}</th>
                <th>{t("dashboard.manager.cols.status", { defaultValue: "Status" })}</th>
                <th>{t("dashboard.manager.cols.in")}</th>
                <th>{t("dashboard.manager.cols.out")}</th>
                <th>{t("dashboard.manager.cols.hours", { defaultValue: "Hours" })}</th>
                <th>{t("dashboard.manager.cols.overtime", { defaultValue: "Overtime" })}</th>
              </tr>
            </thead>
            <tbody>
              {today.isLoading && <SkeletonRows cols={6} rows={5} />}
              {rows.map(({ it, s }) => (
                <tr key={`${it.employee_id}-${it.date}`} className="mgr-row" onClick={() => navigate(`/employees/${it.employee_id}`)}>
                  <td>
                    <div className="mgr-person">
                      <span className="avatar mgr-avatar" style={{ background: avatarBg(it.full_name) }} aria-hidden>
                        {initials(it.full_name)}
                      </span>
                      <span className="mgr-person-text">
                        <span className="dsh-person-name">{it.full_name}</span>
                        <span className="mono text-xs text-dim" style={nowrap}>
                          {it.employee_code} · {it.department.name}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${PILL[s]}`}>
                      <span className="pill-dot" />
                      {s === "holiday" && it.holiday_name ? it.holiday_name : statusLabel[s]}
                    </span>
                  </td>
                  <td className="mono text-sm" style={nowrap}>{clockTime(it.in_time)}</td>
                  <td className="mono text-sm" style={nowrap}>{clockTime(it.out_time)}</td>
                  <td className="mono text-sm" style={nowrap}>{it.total_minutes ? formatMinutes(it.total_minutes) : "—"}</td>
                  <td className="mono text-sm" style={nowrap}>
                    {it.overtime_minutes > 0 ? <span className="mgr-ot">+{formatMinutes(it.overtime_minutes)}</span> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

/** Month-to-date team attendance %: one bar per day, weekends/holidays muted. */
function MonthTrend({
  days,
  loading,
  error,
  onRetry,
  todayIso,
  overtimeToday,
}: {
  days: CompanyDay[] | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  todayIso: string;
  overtimeToday: number;
}) {
  const { t } = useTranslation();
  const working = (days ?? []).filter((d) => d.date <= todayIso && !d.is_weekend && !d.is_holiday && d.active_employees > 0);
  const avg = working.length ? Math.round(working.reduce((s, d) => s + d.percent_present, 0) / working.length) : null;
  const lateTotal = working.reduce((s, d) => s + d.late_count, 0);
  const absentTotal = working.reduce((s, d) => s + d.absent_count, 0);
  const leaveTotal = working.reduce((s, d) => s + d.leave_count, 0);

  return (
    <Panel
      title={t("dashboard.manager.trendTitle", { defaultValue: "This month's attendance" })}
      sub={t("dashboard.manager.trendSub", { defaultValue: "Share of the team present each working day" })}
    >
      {loading ? (
        <SkeletonChart height={180} />
      ) : error ? (
        <PanelError
          title={t("dashboard.manager.trendFailed", { defaultValue: "Couldn't load the month" })}
          body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
          retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
          onRetry={onRetry}
        />
      ) : !days || working.length === 0 ? (
        <PanelEmpty
          icon="activity"
          title={t("dashboard.manager.trendEmpty", { defaultValue: "No working days recorded yet this month" })}
        />
      ) : (
        <>
          <div className="mgr-trend-facts">
            <div>
              <div className="mgr-fact-value">{avg}%</div>
              <div className="mgr-fact-label">{t("dashboard.manager.avgPresent", { defaultValue: "Average present" })}</div>
            </div>
            <div>
              <div className="mgr-fact-value">{lateTotal}</div>
              <div className="mgr-fact-label">{t("dashboard.manager.lateDays", { defaultValue: "Late arrivals" })}</div>
            </div>
            <div>
              <div className="mgr-fact-value">{absentTotal}</div>
              <div className="mgr-fact-label">{t("dashboard.manager.absentDays", { defaultValue: "Absences" })}</div>
            </div>
            <div>
              <div className="mgr-fact-value">{leaveTotal}</div>
              <div className="mgr-fact-label">{t("dashboard.manager.leaveDays", { defaultValue: "Leave days" })}</div>
            </div>
            <div>
              <div className="mgr-fact-value">{overtimeToday > 0 ? formatMinutes(overtimeToday) : "—"}</div>
              <div className="mgr-fact-label">{t("dashboard.manager.overtimeToday", { defaultValue: "Overtime today" })}</div>
            </div>
          </div>
          <div className="mgr-bars" role="img" aria-label={t("dashboard.manager.trendAria", { defaultValue: "Daily attendance percentage this month" })}>
            {days.map((d) => {
              const future = d.date > todayIso;
              const off = d.is_weekend || d.is_holiday;
              const pct = future || off ? 0 : Math.max(2, d.percent_present);
              const day = Number(d.date.slice(8, 10));
              const title = off
                ? `${d.date} · ${d.is_holiday ? d.holiday_name ?? t("dashboard.manager.status.holiday", { defaultValue: "Holiday" }) : t("dashboard.manager.status.weekend", { defaultValue: "Week off" })}`
                : future
                  ? d.date
                  : `${d.date} · ${d.percent_present}% · ${d.present_count} ${t("dashboard.manager.status.present", { defaultValue: "Present" })}, ${d.late_count} ${t("dashboard.manager.status.late", { defaultValue: "Late" })}, ${d.absent_count} ${t("dashboard.manager.status.absent", { defaultValue: "Absent" })}`;
              return (
                <div key={d.date} className={`mgr-bar-col${d.date === todayIso ? " is-today" : ""}${off ? " is-off" : ""}${future ? " is-future" : ""}`} title={title}>
                  <div className="mgr-bar-track">
                    <div className={`mgr-bar${pct >= 90 ? " is-good" : pct >= 70 ? " is-mid" : " is-low"}`} style={{ blockSize: `${pct}%` }} />
                  </div>
                  <span className="mgr-bar-day">{day}</span>
                </div>
              );
            })}
          </div>
          <div className="mgr-legend">
            <span><i className="is-good" /> {t("dashboard.manager.legendGood", { defaultValue: "90%+" })}</span>
            <span><i className="is-mid" /> {t("dashboard.manager.legendMid", { defaultValue: "70–89%" })}</span>
            <span><i className="is-low" /> {t("dashboard.manager.legendLow", { defaultValue: "Below 70%" })}</span>
            <span><i className="is-off" /> {t("dashboard.manager.legendOff", { defaultValue: "Week off / holiday" })}</span>
          </div>
        </>
      )}
    </Panel>
  );
}

function AttentionList({
  tone,
  title,
  rows,
  detail,
  onOpen,
  onMore,
}: {
  tone: "warning" | "danger" | "info";
  title: string;
  rows: AttendanceItem[];
  detail: (it: AttendanceItem) => string;
  onOpen: (employeeId: number) => void;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const shown = rows.slice(0, 4);
  return (
    <section className="mgr-attn-group">
      <div className="mgr-attn-head">
        <span className={`pill pill-${tone}`}>
          <span className="pill-dot" />
          {title}
        </span>
        <span className="mgr-attn-count">{rows.length}</span>
      </div>
      <ul className="mgr-attn-list">
        {shown.map((it) => (
          <li key={it.employee_id}>
            <button type="button" className="mgr-attn-item" onClick={() => onOpen(it.employee_id)}>
              <span className="avatar mgr-avatar" style={{ background: avatarBg(it.full_name) }} aria-hidden>
                {initials(it.full_name)}
              </span>
              <span className="mgr-attn-name">{it.full_name}</span>
              <span className="mgr-attn-detail">{detail(it)}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <button type="button" className="btn btn-sm btn-ghost mgr-attn-more" onClick={onMore}>
          {t("dashboard.manager.more", { defaultValue: "+{{n}} more", n: rows.length - shown.length })}
        </button>
      )}
    </section>
  );
}
