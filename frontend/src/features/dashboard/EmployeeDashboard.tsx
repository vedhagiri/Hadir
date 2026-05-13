// Employee dashboard — at-a-glance summary tiles for the logged-in
// employee. BUG-060: previously this page just rendered
// ``<MyAttendancePage />`` verbatim, so Dashboard and My Attendance
// showed identical content. Now Dashboard shows widget tiles
// (today's status, week summary, latest request) with a CTA into
// the full My Attendance + My Requests pages.

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useMyEmployee } from "../employees/hooks";
import { useMyRecentAttendance } from "../attendance/hooks";
import { useMyRequests } from "../../requests/hooks";


function _fmtMinutes(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  if (h === 0) return `${m} min`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function _fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}


export function EmployeeDashboard() {
  const { t } = useTranslation();
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
  const todayStatus = todayItem
    ? todayItem.absent && todayItem.leave_type_id !== null
      ? { label: "On leave", color: "#6366f1" }
      : !todayItem.in_time
        ? todayItem.is_weekend
          ? { label: "Weekend", color: "#64748b" }
          : todayItem.is_holiday
            ? { label: "Holiday", color: "#0ea5e9" }
            : { label: "Absent", color: "#dc2626" }
        : todayItem.late
          ? { label: "Late", color: "#f59e0b" }
          : todayItem.out_time
            ? { label: "Day complete", color: "#15803d" }
            : { label: "Clocked in", color: "#0b6e4f" }
    : { label: "No record", color: "#64748b" };

  // Pending requests count (submitted + manager_approved).
  const pendingRequests = (requests.data ?? []).filter(
    (r) =>
      r.status === "submitted" ||
      r.status === "manager_approved",
  );
  const recentRequest = (requests.data ?? [])[0] ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Greeting */}
      <div>
        <h1 className="page-title">
          {t("dashboard.employee.greeting", {
            defaultValue: "Welcome back",
          }) as string}
          {me.data?.full_name ? `, ${me.data.full_name}` : ""}
        </h1>
        <p className="page-sub">
          {t("dashboard.employee.subtitle", {
            defaultValue: "Your day at a glance",
          }) as string}
        </p>
      </div>

      {/* Top KPI tiles */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 12,
        }}
      >
        <KpiTile
          label="Today"
          value={todayStatus.label}
          color={todayStatus.color}
          sub={
            todayInTime
              ? `In ${_fmtTime(todayInTime)}${todayOutTime ? ` · Out ${_fmtTime(todayOutTime)}` : ""}`
              : null
          }
        />
        <KpiTile
          label="This week"
          value={`${presentCount} / ${workingDays.length}`}
          color="#0b6e4f"
          sub={`days present · ${attendanceRate}% attendance`}
        />
        <KpiTile
          label="Hours this week"
          value={_fmtMinutes(totalMinutes)}
          color="#2563eb"
          sub={lateCount > 0 ? `${lateCount} late arrival(s)` : "no late arrivals"}
        />
        <KpiTile
          label="Pending requests"
          value={pendingRequests.length.toString()}
          color={pendingRequests.length > 0 ? "#f59e0b" : "#64748b"}
          sub={
            pendingRequests.length > 0
              ? "awaiting decision"
              : "nothing pending"
          }
        />
      </div>

      {/* Two-column body */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 14,
        }}
      >
        {/* Last 7 days panel */}
        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
              Last 7 days
            </span>
            <Link
              to="/my-attendance"
              style={{
                fontSize: 11,
                color: "var(--accent, #0b6e4f)",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              View full attendance →
            </Link>
          </div>
          <div style={{ padding: "10px 16px 16px" }}>
            <table
              style={{
                width: "100%",
                fontSize: 12.5,
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr style={{ color: "var(--text-secondary)" }}>
                  <th style={{ textAlign: "start", padding: "4px 0" }}>Day</th>
                  <th style={{ textAlign: "start", padding: "4px 0" }}>In</th>
                  <th style={{ textAlign: "start", padding: "4px 0" }}>Out</th>
                  <th style={{ textAlign: "end", padding: "4px 0" }}>Hours</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, 7).map((it) => {
                  const date = new Date(`${it.date}T00:00:00Z`);
                  const dayLabel = date.toLocaleDateString(undefined, {
                    weekday: "short",
                    day: "2-digit",
                    month: "short",
                  });
                  return (
                    <tr
                      key={it.date}
                      style={{ borderTop: "1px solid var(--border)" }}
                    >
                      <td style={{ padding: "8px 0", fontWeight: 500 }}>
                        {dayLabel}
                      </td>
                      <td style={{ padding: "8px 0", color: "var(--text-secondary)" }}>
                        {_fmtTime(it.in_time)}
                      </td>
                      <td style={{ padding: "8px 0", color: "var(--text-secondary)" }}>
                        {_fmtTime(it.out_time)}
                      </td>
                      <td
                        style={{
                          padding: "8px 0",
                          textAlign: "end",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {_fmtMinutes(it.total_minutes ?? 0)}
                      </td>
                    </tr>
                  );
                })}
                {items.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      style={{
                        padding: 14,
                        textAlign: "center",
                        color: "var(--text-secondary)",
                      }}
                    >
                      No attendance records yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Latest request panel */}
        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
              My requests
            </span>
            <Link
              to="/my-requests"
              style={{
                fontSize: 11,
                color: "var(--accent, #0b6e4f)",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              View all →
            </Link>
          </div>
          <div style={{ padding: "10px 16px 16px" }}>
            {recentRequest ? (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  background: "var(--bg-elev)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {recentRequest.type === "leave" ? "Leave" : "Exception"}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background:
                        recentRequest.status.endsWith("approved")
                          ? "rgba(34,197,94,0.15)"
                          : recentRequest.status.endsWith("rejected")
                            ? "rgba(220,38,38,0.15)"
                            : "rgba(245,158,11,0.15)",
                      color: recentRequest.status.endsWith("approved")
                        ? "#15803d"
                        : recentRequest.status.endsWith("rejected")
                          ? "#b91c1c"
                          : "#b45309",
                    }}
                  >
                    {recentRequest.status.replace(/_/g, " ")}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: "var(--text)",
                  }}
                >
                  {recentRequest.reason_category || "—"}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 11.5,
                    color: "var(--text-secondary)",
                  }}
                >
                  {recentRequest.target_date_start}
                  {recentRequest.target_date_end &&
                  recentRequest.target_date_end !==
                    recentRequest.target_date_start
                    ? ` → ${recentRequest.target_date_end}`
                    : ""}
                </div>
                {recentRequest.reason_text && (
                  <div
                    style={{
                      marginTop: 10,
                      paddingTop: 10,
                      borderTop: "1px solid var(--border)",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      lineHeight: 1.5,
                    }}
                  >
                    {recentRequest.reason_text}
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  padding: "20px 8px",
                  textAlign: "center",
                  color: "var(--text-secondary)",
                  fontSize: 13,
                }}
              >
                No requests submitted yet.{" "}
                <Link
                  to="/my-requests"
                  style={{
                    color: "var(--accent, #0b6e4f)",
                    textDecoration: "none",
                    fontWeight: 600,
                  }}
                >
                  Submit one →
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function KpiTile({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color: string;
  sub: string | null;
}) {
  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "14px 16px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 22,
          fontWeight: 700,
          color: color,
          lineHeight: 1.1,
          letterSpacing: "-0.01em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11.5,
            color: "var(--text-secondary)",
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
