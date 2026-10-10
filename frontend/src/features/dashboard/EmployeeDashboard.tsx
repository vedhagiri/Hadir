// Employee dashboard — at-a-glance summary tiles for the logged-in
// employee. BUG-060: previously this page just rendered
// ``<MyAttendancePage />`` verbatim, so Dashboard and My Attendance
// showed identical content. Now Dashboard shows widget tiles
// (today's status, week summary, latest request) with a CTA into
// the full My Attendance + My Requests pages.

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useMyEmployee } from "../employees/hooks";
import { useMyRecentAttendance } from "../attendance/hooks";
import type { AttendanceItem } from "../attendance/types";
import { formatMinutes } from "../attendance/timeFormat";
import { useMyRequests } from "../../requests/hooks";
import type { RequestStatus } from "../../requests/types";
import { SkeletonCards, SkeletonRows } from "../../components/Skeleton";
import { Panel, PanelEmpty, PanelError, SoftPill, Tile, TileGrid, clockTime, nowrap } from "./DashUi";
import type { Tone } from "./DashUi";

// Dashboard reuses the shared ``formatMinutes`` helper from
// attendance/timeFormat for consistent ``8h 45m`` rendering.

type DayState =
  | "leave"
  | "weekend"
  | "holiday"
  | "pending"
  | "absent"
  | "late"
  | "complete"
  | "clockedIn"
  | "none";

const DAY_STATE: Record<DayState, { tone: Tone; key: string; fallback: string }> = {
  leave: { tone: "info", key: "dashboard.employee.state.leave", fallback: "On leave" },
  weekend: { tone: "neutral", key: "dashboard.employee.state.weekend", fallback: "Weekend" },
  holiday: { tone: "info", key: "dashboard.employee.state.holiday", fallback: "Holiday" },
  pending: { tone: "neutral", key: "dashboard.employee.state.pending", fallback: "Not checked in yet" },
  absent: { tone: "danger", key: "dashboard.employee.state.absent", fallback: "Absent" },
  late: { tone: "warning", key: "dashboard.employee.state.late", fallback: "Late" },
  complete: { tone: "success", key: "dashboard.employee.state.complete", fallback: "Day complete" },
  clockedIn: { tone: "accent", key: "dashboard.employee.state.clockedIn", fallback: "Clocked in" },
  none: { tone: "neutral", key: "dashboard.employee.state.none", fallback: "No record" },
};

function dayState(it: AttendanceItem | null): DayState {
  if (!it) return "none";
  if (it.leave_type_id !== null) return "leave";
  if (!it.in_time) {
    if (it.is_weekend) return "weekend";
    if (it.is_holiday) return "holiday";
    if (it.pending) return "pending";
    return "absent";
  }
  if (it.late) return "late";
  return it.out_time ? "complete" : "clockedIn";
}

const STAGE_KEY: Record<RequestStatus, string> = {
  submitted: "submitted",
  manager_approved: "managerApproved",
  manager_rejected: "managerRejected",
  hr_approved: "hrApproved",
  hr_rejected: "hrRejected",
  admin_approved: "adminApproved",
  admin_rejected: "adminRejected",
  cancelled: "cancelled",
};

function requestTone(status: RequestStatus): Tone {
  if (status.endsWith("approved") && status !== "manager_approved") return "success";
  if (status.endsWith("rejected")) return "danger";
  if (status === "cancelled") return "neutral";
  return "warning";
}

export function EmployeeDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMyEmployee();
  const week = useMyRecentAttendance(7);
  const today = useMyRecentAttendance(1);
  const requests = useMyRequests();

  // Aggregate last-7-day stats. Excludes weekends + holidays from the
  // attendance-rate denominator so the displayed % is meaningful.
  const items = week.data?.items ?? [];
  const workingDays = items.filter(
    (i) => !i.is_holiday && !i.is_weekend,
  );
  const presentCount = workingDays.filter((i) => i.in_time).length;
  const lateCount = workingDays.filter((i) => i.late).length;
  const totalMinutes = workingDays.reduce(
    (acc, i) => acc + (i.total_minutes ?? 0),
    0,
  );
  const attendanceRate =
    workingDays.length > 0
      ? Math.round((presentCount / workingDays.length) * 100)
      : 0;

  // Today's row — items[0] is the most-recent date.
  const todayItem = today.data?.items[0] ?? null;
  const todayInTime = todayItem?.in_time ?? null;
  const todayOutTime = todayItem?.out_time ?? null;
  const todayState = DAY_STATE[dayState(todayItem)];

  // Pending requests count (submitted + manager_approved).
  const pendingRequests = (requests.data ?? []).filter(
    (r) =>
      r.status === "submitted" ||
      r.status === "manager_approved",
  );
  const recentRequests = (requests.data ?? []).slice(0, 3);

  const fmtDay = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("dashboard.employee.greeting", { name: me.data?.full_name ?? "" })}
          </h1>
          <p className="page-sub">{t("dashboard.employee.subtitle")}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => navigate("/my-requests")}>
            {t("dashboard.employee.newRequest", { defaultValue: "My requests" })}
          </button>
        </div>
      </div>

      {today.isLoading || week.isLoading ? (
        <div style={{ marginBottom: 20 }}>
          <SkeletonCards count={4} />
        </div>
      ) : (
        <TileGrid>
          <Tile
            tone={todayState.tone}
            icon="clock"
            label={t("dashboard.employee.tiles.today", { defaultValue: "Today" })}
            value={t(todayState.key, { defaultValue: todayState.fallback })}
            sub={
              todayInTime
                ? todayOutTime
                  ? t("dashboard.employee.tiles.inOut", {
                      defaultValue: "In {{in}} · Out {{out}}",
                      in: clockTime(todayInTime),
                      out: clockTime(todayOutTime),
                    })
                  : t("dashboard.employee.tiles.inOnly", {
                      defaultValue: "In {{in}}",
                      in: clockTime(todayInTime),
                    })
                : t("dashboard.employee.tiles.noCheckIn", { defaultValue: "No check-in recorded" })
            }
            onClick={() => navigate("/my-attendance")}
          />
          <Tile
            tone="success"
            icon="calendar"
            label={t("dashboard.employee.tiles.thisWeek", { defaultValue: "This week" })}
            value={`${presentCount} / ${workingDays.length}`}
            sub={t("dashboard.employee.tiles.daysPresent", {
              defaultValue: "days present · {{pct}}% attendance",
              pct: attendanceRate,
            })}
            onClick={() => navigate("/my-attendance")}
          />
          <Tile
            tone={lateCount > 0 ? "warning" : "info"}
            icon="activity"
            label={t("dashboard.employee.tiles.hours", { defaultValue: "Hours this week" })}
            value={totalMinutes > 0 ? formatMinutes(totalMinutes) : "—"}
            sub={
              lateCount > 0
                ? t("dashboard.employee.tiles.lateCount", {
                    defaultValue: "{{count}} late arrival(s)",
                    count: lateCount,
                  })
                : t("dashboard.employee.tiles.noLate", { defaultValue: "no late arrivals" })
            }
          />
          <Tile
            tone={pendingRequests.length > 0 ? "warning" : "neutral"}
            icon="inbox"
            label={t("dashboard.employee.tiles.pending", { defaultValue: "Pending requests" })}
            value={pendingRequests.length}
            sub={
              pendingRequests.length > 0
                ? t("dashboard.employee.tiles.awaiting", { defaultValue: "awaiting decision" })
                : t("dashboard.employee.tiles.nothingPending", { defaultValue: "nothing pending" })
            }
            onClick={() => navigate("/my-requests")}
          />
        </TileGrid>
      )}

      <div className="dsh-row-auto">
        <Panel
          title={t("dashboard.employee.week.title", { defaultValue: "Last 7 days" })}
          sub={t("dashboard.employee.week.sub", { defaultValue: "Check-in, check-out and hours per day" })}
          bodyPadding={0}
          actions={
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("/my-attendance")}>
              {t("dashboard.employee.week.viewAll", { defaultValue: "View full attendance" })}
            </button>
          }
        >
          {week.isError ? (
            <PanelError
              title={t("dashboard.employee.week.loadFailed", { defaultValue: "Couldn't load your attendance" })}
              body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
              retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
              onRetry={() => void week.refetch()}
            />
          ) : !week.isLoading && items.length === 0 ? (
            <PanelEmpty
              tone="accent"
              icon="calendar"
              title={t("dashboard.employee.week.emptyTitle", { defaultValue: "No attendance yet" })}
              body={t("dashboard.employee.week.empty", {
                defaultValue: "Your days will appear here once the cameras record your first check-in.",
              })}
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("dashboard.employee.week.cols.day", { defaultValue: "Day" })}</th>
                  <th>{t("dashboard.employee.week.cols.in", { defaultValue: "In" })}</th>
                  <th>{t("dashboard.employee.week.cols.out", { defaultValue: "Out" })}</th>
                  <th className="dsh-end">{t("dashboard.employee.week.cols.hours", { defaultValue: "Hours" })}</th>
                  <th>{t("dashboard.employee.week.cols.status", { defaultValue: "Status" })}</th>
                </tr>
              </thead>
              <tbody>
                {week.isLoading && <SkeletonRows cols={5} rows={5} />}
                {items.slice(0, 7).map((it) => {
                  const st = DAY_STATE[dayState(it)];
                  return (
                    <tr key={it.date}>
                      <td className="text-sm dsh-strong" style={nowrap}>{fmtDay(it.date)}</td>
                      <td className="mono text-sm" style={nowrap}>{clockTime(it.in_time)}</td>
                      <td className="mono text-sm" style={nowrap}>{clockTime(it.out_time)}</td>
                      <td className="mono text-sm dsh-end" style={nowrap}>
                        {it.total_minutes != null && it.total_minutes > 0
                          ? formatMinutes(it.total_minutes)
                          : "—"}
                      </td>
                      <td>
                        <SoftPill tone={st.tone}>{t(st.key, { defaultValue: st.fallback })}</SoftPill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title={t("dashboard.employee.requests.title", { defaultValue: "My requests" })}
          sub={t("dashboard.employee.requests.sub", { defaultValue: "Your latest leave and exception requests" })}
          actions={
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("/my-requests")}>
              {t("dashboard.employee.requests.viewAll", { defaultValue: "View all" })}
            </button>
          }
        >
          {requests.isLoading ? (
            <SkeletonCards count={2} minWidth={260} />
          ) : requests.isError ? (
            <PanelError
              title={t("dashboard.employee.requests.loadFailed", { defaultValue: "Couldn't load your requests" })}
              body={t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." })}
              retryLabel={t("dashboard.common.retry", { defaultValue: "Retry" })}
              onRetry={() => void requests.refetch()}
            />
          ) : recentRequests.length === 0 ? (
            <PanelEmpty
              tone="accent"
              icon="clipboard"
              title={t("dashboard.employee.requests.emptyTitle", { defaultValue: "No requests yet" })}
              body={t("dashboard.employee.requests.empty", {
                defaultValue: "Need a leave day or an attendance correction? File a request and your manager will review it.",
              })}
              action={
                <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate("/my-requests")}>
                  {t("dashboard.employee.requests.submit", { defaultValue: "Submit a request" })}
                </button>
              }
            />
          ) : (
            <div className="dsh-req-list">
              {recentRequests.map((r) => (
                <button key={r.id} type="button" className="card dsh-req-card" onClick={() => navigate("/my-requests")}>
                  <span className="dsh-req-top">
                    <span className="dsh-req-title">
                      {(r.type === "leave"
                        ? t("myRequests.filters.leave")
                        : t("myRequests.filters.exception")) +
                        (r.reason_category ? ` · ${r.reason_category}` : "")}
                    </span>
                    <SoftPill tone={requestTone(r.status)}>
                      {t(`approvals.stages.${STAGE_KEY[r.status]}`)}
                    </SoftPill>
                  </span>
                  <span className="dsh-req-dates">
                    {r.target_date_start}
                    {r.target_date_end && r.target_date_end !== r.target_date_start
                      ? ` → ${r.target_date_end}`
                      : ""}
                  </span>
                  {r.reason_text && <span className="dsh-req-reason">{r.reason_text}</span>}
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
