// HR dashboard — composed against existing endpoints. The reference
// in docs/scripts/issues-screenshots/11-HR_Dashboard.png shows three
// surfaces backed by data we don't ship yet (KPI sparklines,
// company-wide presence trend, hour×weekday arrival heatmap); those
// land once the daily-aggregate + arrival-density endpoints exist.
// This file wires every panel that runs off endpoints already shipped.

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { useMe } from "../../auth/AuthProvider";
import { usePolicies } from "../../policies/hooks";
import { useInboxPending, useInboxSummary } from "../../requests/hooks";
import type { RequestRecord } from "../../requests/types";
import {
  useReportSchedules,
  useRunNow,
} from "../../scheduled-reports/hooks";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import { useAttendance } from "../attendance/hooks";
import type { AttendanceItem } from "../attendance/types";
import { useDepartments } from "../departments/hooks";
import { StatCard } from "./StatCard";
import { StatusBreakdown } from "./StatusBreakdown";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Bucket = "present" | "late" | "absent" | "onLeave" | "off" | "pending";

// Mirrors DailyStatusPill and the Department Summary classifier. A
// row that's a weekend / holiday / future check-in maps to ``off``
// and is excluded from working-day totals.
function classify(it: AttendanceItem): Bucket {
  if (it.is_holiday && !it.in_time) return "off";
  if (it.is_weekend && !it.in_time) return "off";
  if (it.pending) return "pending";
  if (it.absent && it.leave_type_id !== null) return "onLeave";
  if (!it.in_time) return "absent";
  if (it.late) return "late";
  return "present";
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.length >= 5 ? iso.slice(0, 5) : iso;
}

function hoursDecimal(min: number | null): string {
  if (min === null) return "—";
  return `${(min / 60).toFixed(1)}h`;
}

export function HrDashboard() {
  const navigate = useNavigate();
  const me = useMe();
  const today = useAttendance(todayIso(), null);
  const departments = useDepartments();
  const inboxPending = useInboxPending();
  const inboxSummary = useInboxSummary();
  const policies = usePolicies();
  const schedules = useReportSchedules();
  const runNow = useRunNow();

  const items = today.data?.items ?? [];

  // Today's working-day population + bucket counts.
  const summary = useMemo(() => {
    let present = 0,
      late = 0,
      absent = 0,
      onLeave = 0,
      working = 0;
    for (const it of items) {
      const b = classify(it);
      if (b === "off" || b === "pending") continue;
      working += 1;
      if (b === "present") present += 1;
      else if (b === "late") late += 1;
      else if (b === "absent") absent += 1;
      else if (b === "onLeave") onLeave += 1;
    }
    const presentPct =
      working === 0
        ? null
        : Math.round(((present + late) / working) * 100);
    return { present, late, absent, onLeave, working, presentPct };
  }, [items]);

  // Per-department stacked bar source — every department, even
  // empty ones, sorted by code.
  const deptRows = useMemo(() => {
    const allDepts = departments.data?.items ?? [];
    type DRow = {
      id: number;
      code: string;
      name: string;
      present: number;
      late: number;
      absent: number;
      onLeave: number;
      total: number;
    };
    const byDept = new Map<number, DRow>();
    for (const d of allDepts) {
      byDept.set(d.id, {
        id: d.id,
        code: d.code,
        name: d.name,
        present: 0,
        late: 0,
        absent: 0,
        onLeave: 0,
        total: 0,
      });
    }
    for (const it of items) {
      let row = byDept.get(it.department.id);
      if (!row) {
        row = {
          id: it.department.id,
          code: it.department.code,
          name: it.department.name,
          present: 0,
          late: 0,
          absent: 0,
          onLeave: 0,
          total: 0,
        };
        byDept.set(it.department.id, row);
      }
      row.total += 1;
      const b = classify(it);
      if (b === "present") row.present += 1;
      else if (b === "late") row.late += 1;
      else if (b === "absent") row.absent += 1;
      else if (b === "onLeave") row.onLeave += 1;
    }
    return Array.from(byDept.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }, [departments.data, items]);

  // Ramadan banner — show when an active Ramadan policy covers today.
  const ramadanBanner = useMemo(() => {
    const all = policies.data ?? [];
    const t = todayIso();
    const active = all.find(
      (p) =>
        p.type === "Ramadan" &&
        p.config.start_date &&
        p.config.end_date &&
        p.config.start_date <= t &&
        t <= p.config.end_date,
    );
    if (!active) return null;
    const end = active.config.end_date!;
    const daysLeft = Math.max(
      0,
      Math.round(
        (new Date(end).getTime() - new Date(t).getTime()) / 86_400_000,
      ),
    );
    return daysLeft > 0
      ? `Ramadan · ${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining`
      : "Ramadan ends today";
  }, [policies.data]);

  const subtitle = useMemo(() => {
    const d = new Date();
    const day = d.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const parts = [day];
    if (ramadanBanner) parts.push(ramadanBanner);
    if (summary.presentPct !== null) {
      parts.push(`${summary.presentPct}% presence company-wide today`);
    }
    return parts.join(" · ");
  }, [ramadanBanner, summary.presentPct]);

  // "Send daily report": find the first active xlsx schedule and
  // run it. Falls back to the schedules settings page when none
  // exists (operator has to create one first).
  const dailySchedule = useMemo(() => {
    return (schedules.data ?? []).find(
      (s) => s.active && s.format === "xlsx",
    );
  }, [schedules.data]);

  function downloadTodayXlsx() {
    const url = "/api/reports/attendance.xlsx";
    void fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: todayIso(), end: todayIso() }),
    })
      .then(async (r) => {
        if (!r.ok) {
          toast.error(`Export failed (${r.status})`);
          return;
        }
        const blob = await r.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `attendance_${todayIso()}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        toast.success("Today's attendance exported");
      })
      .catch(() => toast.error("Network error"));
  }

  function sendDailyReport() {
    if (!dailySchedule) {
      toast.warning("No active daily schedule — create one in Settings");
      navigate("/settings/schedules");
      return;
    }
    runNow.mutate(dailySchedule.id, {
      onSuccess: () =>
        toast.success(`Queued: ${dailySchedule.name}`),
      onError: () => toast.error("Could not run the schedule"),
    });
  }

  // Live attendance preview — top N rows with a "View all" link.
  const PREVIEW_ROWS = 10;
  const attendancePreview = items.slice(0, PREVIEW_ROWS);

  // Approval queue preview — top N pending the viewer can act on.
  const APPROVALS_PREVIEW = 5;
  const pendingPreview = (inboxPending.data ?? []).slice(0, APPROVALS_PREVIEW);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data
              ? `Good ${greeting()}, ${firstName(me.data.full_name)}`
              : "HR Dashboard"}
          </h1>
          <p className="page-sub">{subtitle}</p>
        </div>
        <div className="page-actions" style={{ display: "flex", gap: 8 }}>
          <button
            className="btn"
            onClick={downloadTodayXlsx}
            title="Download today's attendance as XLSX"
          >
            <Icon name="download" size={12} /> Export today
          </button>
          <button
            className="btn btn-primary"
            onClick={sendDailyReport}
            disabled={runNow.isPending}
            title={
              dailySchedule
                ? `Run "${dailySchedule.name}" now`
                : "Create an active daily schedule in Settings"
            }
          >
            <Icon name="send" size={12} />
            {runNow.isPending ? "Sending…" : "Send daily report"}
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard
          label="Present today"
          value={
            summary.presentPct === null ? "—" : `${summary.presentPct}%`
          }
          sub={`${summary.present + summary.late} of ${summary.working} working`}
          icon="users"
        />
        <StatCard
          label="Late arrivals"
          value={String(summary.late)}
          sub="past grace window"
          icon="clock"
        />
        <StatCard
          label="Pending approvals"
          value={String(inboxSummary.data?.pending_count ?? 0)}
          sub={
            inboxSummary.data && inboxSummary.data.breached_count > 0
              ? `${inboxSummary.data.breached_count} past SLA`
              : "with HR / managers"
          }
          icon="inbox"
        />
        <StatCard
          label="Identification rate"
          value="—"
          sub="HR endpoint pending"
          icon="zap"
        />
      </div>

      {/* Status breakdown + Department roll-up */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "1fr 2fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <StatusBreakdown
          title="Status breakdown · today"
          caption={today.data?.date ?? ""}
          slices={[
            { label: "Present", value: summary.present, tone: "success" },
            { label: "Late", value: summary.late, tone: "warning" },
            { label: "On leave", value: summary.onLeave, tone: "info" },
            { label: "Absent", value: summary.absent, tone: "danger" },
          ]}
        />
        <DeptStack rows={deptRows} loading={departments.isLoading} />
      </div>

      {/* Approval queue + Scheduled reports */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "1.3fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <ApprovalQueue
          rows={pendingPreview}
          totalPending={inboxSummary.data?.pending_count ?? 0}
          loading={inboxPending.isLoading}
          onSeeAll={() => navigate("/approvals")}
        />
        <ScheduledReports
          rows={schedules.data ?? []}
          loading={schedules.isLoading}
          onManage={() => navigate("/settings/schedules")}
          onRun={(id, name) =>
            runNow.mutate(id, {
              onSuccess: () => toast.success(`Queued: ${name}`),
              onError: () => toast.error("Could not run the schedule"),
            })
          }
          runningId={runNow.isPending ? runNow.variables ?? null : null}
        />
      </div>

      {/* Live attendance preview */}
      <LiveAttendance
        rows={attendancePreview}
        total={items.length}
        loading={today.isLoading}
        onSeeAll={() => navigate("/daily-attendance")}
      />
    </>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}

// ---------------------------------------------------------------------------
// Department stacked bar
// ---------------------------------------------------------------------------

interface DeptRow {
  id: number;
  code: string;
  name: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  total: number;
}

function DeptStack({
  rows,
  loading,
}: {
  rows: DeptRow[];
  loading: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">By department · today</h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            Present / Late / On leave / Absent
          </div>
        </div>
      </div>
      <div
        className="card-body"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {loading && (
          <div className="text-sm text-dim">Loading departments…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="text-sm text-dim">No departments configured.</div>
        )}
        {!loading &&
          rows.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "120px 1fr 60px", gap: 8, alignItems: "center" }}>
              <div
                className="text-sm"
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontWeight: 500,
                }}
                title={r.name}
              >
                {r.name}
              </div>
              <div
                style={{
                  display: "flex",
                  height: 14,
                  borderRadius: 4,
                  overflow: "hidden",
                  background: "var(--bg-sunken)",
                  border: "1px solid var(--border)",
                  width: `${(r.total / max) * 100}%`,
                  minWidth: r.total > 0 ? 6 : 0,
                }}
              >
                {r.present > 0 && (
                  <div
                    title={`Present ${r.present}`}
                    style={{ flex: r.present, background: "var(--success)" }}
                  />
                )}
                {r.late > 0 && (
                  <div
                    title={`Late ${r.late}`}
                    style={{ flex: r.late, background: "var(--warning)" }}
                  />
                )}
                {r.onLeave > 0 && (
                  <div
                    title={`On leave ${r.onLeave}`}
                    style={{ flex: r.onLeave, background: "var(--info)" }}
                  />
                )}
                {r.absent > 0 && (
                  <div
                    title={`Absent ${r.absent}`}
                    style={{ flex: r.absent, background: "var(--danger)" }}
                  />
                )}
              </div>
              <div
                className="text-xs text-dim mono"
                style={{ textAlign: "end" }}
              >
                {r.total}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approval queue
// ---------------------------------------------------------------------------

function ApprovalQueue({
  rows,
  totalPending,
  loading,
  onSeeAll,
}: {
  rows: RequestRecord[];
  totalPending: number;
  loading: boolean;
  onSeeAll: () => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">
            Approval queue
            {totalPending > 0 && (
              <span
                className="pill pill-warning"
                style={{ marginInlineStart: 8, fontSize: 11 }}
              >
                {totalPending} pending
              </span>
            )}
          </h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            HR-level final approvals
          </div>
        </div>
        <button className="btn btn-sm" onClick={onSeeAll}>
          See all
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>EMPLOYEE</th>
            <th>TYPE</th>
            <th>DATE</th>
            <th>STAGE</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td
                colSpan={4}
                className="text-sm text-dim"
                style={{ padding: 14, textAlign: "center" }}
              >
                Loading…
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={4}
                className="text-sm text-dim"
                style={{ padding: 14, textAlign: "center" }}
              >
                No pending requests assigned to you.
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((r) => (
              <tr
                key={r.id}
                style={{ cursor: "pointer" }}
                onClick={onSeeAll}
              >
                <td>
                  <div className="text-sm" style={{ fontWeight: 500 }}>
                    {r.employee.full_name}
                  </div>
                  <div className="text-xs text-dim">
                    {r.employee.employee_code}
                  </div>
                </td>
                <td className="text-sm">
                  {r.type === "exception" ? "Exception" : "Leave"}
                </td>
                <td className="mono text-sm">{r.target_date_start}</td>
                <td>
                  <StagePill status={r.status} breached={r.sla_breached} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function StagePill({
  status,
  breached,
}: {
  status: string;
  breached: boolean;
}) {
  let label = status.replace("_", " ");
  let tone = "pill-info";
  if (status === "submitted" || status === "manager_approved") {
    label = status === "submitted" ? "Pending manager" : "Pending HR";
    tone = breached ? "pill-danger" : "pill-warning";
  } else if (status.endsWith("approved")) {
    tone = "pill-success";
  } else if (status.endsWith("rejected")) {
    tone = "pill-danger";
  }
  return <span className={`pill ${tone}`}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Scheduled reports
// ---------------------------------------------------------------------------

interface ScheduleRow {
  id: number;
  name: string;
  format: string;
  schedule_cron: string;
  active: boolean;
  recipients: string[];
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
}

function ScheduledReports({
  rows,
  loading,
  onManage,
  onRun,
  runningId,
}: {
  rows: ScheduleRow[];
  loading: boolean;
  onManage: () => void;
  onRun: (id: number, name: string) => void;
  runningId: number | null;
}) {
  const next = rows
    .filter((r) => r.active && r.next_run_at)
    .map((r) => r.next_run_at as string)
    .sort()[0];
  const subtitle = next
    ? `Next delivery ${formatRelative(next)}`
    : "No upcoming deliveries";
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">Scheduled reports</h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {subtitle}
          </div>
        </div>
        <button className="btn btn-sm" onClick={onManage}>
          Manage
        </button>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {loading && (
          <div className="text-sm text-dim" style={{ padding: 14 }}>
            Loading schedules…
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="text-sm text-dim" style={{ padding: 14 }}>
            No schedules yet — set one up in Settings.
          </div>
        )}
        {!loading &&
          rows.slice(0, 4).map((s, i) => (
            <div
              key={s.id}
              style={{
                padding: "10px 14px",
                borderBottom:
                  i < Math.min(rows.length, 4) - 1
                    ? "1px solid var(--border)"
                    : 0,
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={s.name}
                >
                  {s.name}
                </div>
                <div
                  className="text-xs text-dim mono"
                  style={{
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={`${s.schedule_cron} · ${s.format.toUpperCase()}`}
                >
                  {s.schedule_cron} · {s.format.toUpperCase()}
                </div>
                {s.recipients.length > 0 && (
                  <div
                    className="text-xs text-dim"
                    style={{
                      marginTop: 2,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={s.recipients.join(", ")}
                  >
                    <Icon name="mail" size={11} />
                    {s.recipients.join(", ")}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  className={`pill ${s.active ? "pill-success" : "pill-neutral"}`}
                  style={{ fontSize: 10.5 }}
                >
                  {s.active ? "Active" : "Paused"}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => onRun(s.id, s.name)}
                  disabled={!s.active || runningId === s.id}
                  title={s.active ? "Run now" : "Activate to run"}
                >
                  {runningId === s.id ? "…" : "Run"}
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const target = new Date(iso);
  if (isNaN(target.getTime())) return iso;
  const diffMs = target.getTime() - Date.now();
  const mins = Math.round(diffMs / 60_000);
  if (Math.abs(mins) < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return `in ${days} day${Math.abs(days) === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Live attendance preview
// ---------------------------------------------------------------------------

function LiveAttendance({
  rows,
  total,
  loading,
  onSeeAll,
}: {
  rows: AttendanceItem[];
  total: number;
  loading: boolean;
  onSeeAll: () => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">Today's attendance · live</h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {total === 0
              ? "No rows yet"
              : `Showing ${rows.length} of ${total}`}
          </div>
        </div>
        <button className="btn btn-sm" onClick={onSeeAll}>
          View all
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>EMPLOYEE</th>
            <th>DEPT</th>
            <th>POLICY</th>
            <th>IN</th>
            <th>OUT</th>
            <th>HOURS</th>
            <th>STATUS</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td
                colSpan={7}
                className="text-sm text-dim"
                style={{ padding: 14, textAlign: "center" }}
              >
                Loading…
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={7}
                className="text-sm text-dim"
                style={{ padding: 14, textAlign: "center" }}
              >
                No attendance rows yet today.
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((it) => (
              <tr key={`${it.employee_id}-${it.date}`}>
                <td>
                  <div className="text-sm" style={{ fontWeight: 500 }}>
                    {it.full_name}
                  </div>
                  <div className="text-xs text-dim mono">
                    {it.employee_code}
                  </div>
                </td>
                <td className="text-sm">{it.department.name}</td>
                <td className="text-sm">{it.policy.name}</td>
                <td className="mono text-sm">{shortTime(it.in_time)}</td>
                <td className="mono text-sm">{shortTime(it.out_time)}</td>
                <td className="mono text-sm">
                  {hoursDecimal(it.total_minutes)}
                </td>
                <td>
                  <AttendancePill it={it} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function AttendancePill({ it }: { it: AttendanceItem }) {
  const b = classify(it);
  if (b === "off") {
    if (it.is_holiday) {
      return (
        <span className="pill pill-info">
          Holiday{it.holiday_name ? ` — ${it.holiday_name}` : ""}
        </span>
      );
    }
    return <span className="pill pill-neutral">Weekend</span>;
  }
  if (b === "pending") {
    return <span className="pill pill-info">Waiting for login</span>;
  }
  if (b === "onLeave") return <span className="pill pill-info">On leave</span>;
  if (b === "absent") return <span className="pill pill-danger">Absent</span>;
  if (b === "late") return <span className="pill pill-warning">Late</span>;
  return <span className="pill pill-success">Present</span>;
}
