// "My attendance" — self-view ported from frontend/src/design/employee.jsx
// (the EmployeeDashboard component). Layout: header → today + month
// donut → clickable month calendar → rolling 14-day timeline. The
// calendar's day click opens DayDetailDrawer (camera evidence + day
// detail) — the existing P28.6 drawer already covers the "camera
// events tab + attendance details" surface the prompt asked for.
//
// Mounted at /my-attendance and /attendance/me, and re-exported by
// EmployeeDashboard so the Employee role's dashboard is this page.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useMe } from "../../auth/AuthProvider";
import { Icon } from "../../shell/Icon";
import { NewRequestDrawer } from "../../requests/NewRequestDrawer";
import { DayDetailDrawer } from "../calendar/DayDetailDrawer";
import { PersonView } from "../calendar/PersonView";
import { usePersonCalendar } from "../calendar/hooks";
import type { CalendarStatus, PersonDay } from "../calendar/types";
import { useMyEmployee } from "../employees/hooks";
import { useMyRecentAttendance } from "./hooks";
import type { AttendanceItem } from "./types";

export function MyAttendancePage() {
  const me = useMe();
  const [month, setMonth] = useState<string>(currentMonth());
  const [drawerDate, setDrawerDate] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);

  // Backend resolves user → employee by lower-cased email match
  // (GET /api/employees/me). Returns null when the account isn't
  // linked to an employee row — Admin/HR accounts often aren't.
  const myEmployee = useMyEmployee();
  const employeeId = myEmployee.data?.id ?? null;

  const person = usePersonCalendar(employeeId, month);
  const recent = useMyRecentAttendance(14);

  const todayDate = todayIso();
  const todayDay = person.data?.days.find((d) => d.date === todayDate) ?? null;

  const recentSorted = useMemo(() => {
    const items = recent.data?.items ?? [];
    return [...items].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [recent.data]);

  const monthLabel = useMemo(() => {
    if (!person.data?.month) return monthFromIso(month);
    return monthFromIso(person.data.month);
  }, [person.data?.month, month]);

  const headerSub = useMemo(() => {
    const policyName = todayDay?.policy_name;
    return policyName
      ? `Today's attendance · Policy ${policyName}`
      : "Today's attendance";
  }, [todayDay?.policy_name]);

  return (
    <>
      {/* ---------- Page header ---------- */}
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data?.full_name
              ? `Hello, ${firstName(me.data.full_name)}`
              : "My attendance"}
          </h1>
          <p className="page-sub">{headerSub}</p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/my-profile">
            <Icon name="upload" size={12} />
            Update photo
          </Link>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setRequestOpen(true)}
          >
            <Icon name="plus" size={12} />
            Submit request
          </button>
        </div>
      </div>

      {/* ---------- Today + at-a-glance ---------- */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "1.3fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <TodayCard day={todayDay} loading={person.isLoading} />
        <AtAGlanceCard
          days={person.data?.days ?? []}
          monthLabel={monthLabel}
        />
      </div>

      {/* ---------- Month calendar (clickable) ---------- */}
      <div style={{ marginBottom: 16 }}>
        <div
          className="flex items-center justify-between"
          style={{ marginBottom: 10, gap: 12, flexWrap: "wrap" }}
        >
          <div>
            <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>
              Attendance calendar · {monthLabel}
            </h3>
            <p className="text-xs text-dim" style={{ marginTop: 2 }}>
              Click any day to see evidence, hours and flags · color by
              status
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label="Previous month"
            >
              <Icon name="chevronLeft" size={13} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setMonth(currentMonth())}
            >
              Today
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMonth(shiftMonth(month, 1))}
              aria-label="Next month"
            >
              <Icon name="chevronRight" size={13} />
            </button>
          </div>
        </div>
        {employeeId === null && myEmployee.isLoading && (
          <div className="card" style={{ padding: 16 }}>
            <div className="text-sm text-dim">
              Linking your account to an employee record…
            </div>
          </div>
        )}
        {employeeId === null && !myEmployee.isLoading && (
          <div className="card" style={{ padding: 16 }}>
            <div className="text-sm text-dim">
              No employee record is linked to this account. Ask an HR
              admin to add you as an employee using the same email.
            </div>
          </div>
        )}
        {employeeId !== null && person.isLoading && (
          <div className="card" style={{ padding: 16 }}>
            <div className="text-sm text-dim">Loading calendar…</div>
          </div>
        )}
        {employeeId !== null && person.isError && (
          <div className="card" style={{ padding: 16 }}>
            <div
              className="text-sm"
              style={{ color: "var(--danger-text)" }}
            >
              Couldn't load this month. Try again.
            </div>
          </div>
        )}
        {employeeId !== null && person.data && (
          <PersonView
            person={person.data}
            onPickDay={(iso) => setDrawerDate(iso)}
          />
        )}
        <CalendarLegend />
      </div>

      {/* ---------- Rolling 14 days ---------- */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">Rolling 14 days</h3>
            <p className="card-sub">In / out plotted against policy</p>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          {recent.isLoading && (
            <div className="text-sm text-dim">Loading…</div>
          )}
          {!recent.isLoading && recentSorted.length === 0 && (
            <div className="text-sm text-dim">No attendance yet.</div>
          )}
          {recentSorted.map((it) => (
            <Rolling14Row
              key={it.date}
              item={it}
              onClick={() => setDrawerDate(it.date)}
            />
          ))}
        </div>
      </div>

      {/* ---------- Drawers ---------- */}
      {employeeId !== null && drawerDate && (
        <DayDetailDrawer
          employeeId={employeeId}
          isoDate={drawerDate}
          onClose={() => setDrawerDate(null)}
          onSubmitException={(iso) => {
            setRequestOpen(true);
            setDrawerDate(null);
            // Carry the date forward via component state — Submit
            // request opens with today's date by default; for a deeper
            // tie-in we'd lift the date into a separate state. Keep
            // it simple here and let the user adjust the date in the
            // request drawer.
            void iso;
          }}
        />
      )}

      {requestOpen && (
        <NewRequestDrawer
          onClose={() => setRequestOpen(false)}
          onCreated={() => setRequestOpen(false)}
        />
      )}
    </>
  );
}

// ----------------------------------------------------------------------
// Today card
// ----------------------------------------------------------------------

function TodayCard({
  day,
  loading,
}: {
  day: PersonDay | null;
  loading: boolean;
}) {
  const today = todayIso();
  const date = new Date(`${today}T00:00:00`);
  const headerDate = date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const onSite = !!day?.in_time && !day?.out_time;
  const totalLabel =
    day?.total_minutes != null && day.total_minutes > 0
      ? formatHoursColon(day.total_minutes)
      : onSite
        ? "—"
        : "—";

  const otLabel =
    day && day.overtime_minutes > 0
      ? `${(day.overtime_minutes / 60).toFixed(1)}h`
      : "0h";

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">Today · {headerDate}</h3>
          <p className="card-sub">
            {day?.in_time
              ? onSite
                ? "On site since clock-in"
                : "Clocked out for the day"
              : "No events captured yet"}
          </p>
        </div>
        {day && <StatusPill status={day.status} />}
      </div>
      <div className="card-body">
        {loading && <div className="text-sm text-dim">Loading…</div>}
        {!loading && (
          <>
            <div
              className="grid grid-4"
              style={{ gap: 10, marginBottom: 14 }}
            >
              <Tile
                label="In time"
                value={day?.in_time?.slice(0, 8) ?? "—"}
                sub={day?.in_time ? "Earliest detection" : "Not detected"}
              />
              <Tile
                label="Out time"
                value={day?.out_time?.slice(0, 8) ?? "—"}
                sub={onSite ? "Still on site" : day?.out_time ? "Latest detection" : "—"}
              />
              <Tile label="Total" value={totalLabel} sub="hrs · since in" />
              <Tile label="Overtime" value={otLabel} sub="today" />
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-tertiary)",
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 500,
              }}
            >
              Day timeline
            </div>
            <DayRuler day={day} />
            <div
              className="flex items-center gap-4"
              style={{
                marginTop: 10,
                fontSize: 11,
                color: "var(--text-secondary)",
                flexWrap: "wrap",
              }}
            >
              <LegendDot
                label="Policy window"
                style={{
                  width: 12,
                  height: 4,
                  background: "var(--accent-soft)",
                  border: "1px dashed var(--accent-border)",
                }}
              />
              <LegendDot
                label="On site"
                style={{
                  width: 12,
                  height: 4,
                  background: "var(--accent)",
                  borderRadius: 2,
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// At-a-glance (donut + counters)
// ----------------------------------------------------------------------

function AtAGlanceCard({
  days,
  monthLabel,
}: {
  days: PersonDay[];
  monthLabel: string;
}) {
  const counts = useMemo(() => countStatuses(days), [days]);
  const overtimeHours = useMemo(
    () => days.reduce((s, d) => s + (d.overtime_minutes ?? 0), 0) / 60,
    [days],
  );

  const parts = [
    { label: "Present", value: counts.present, color: "var(--accent)" },
    { label: "Late", value: counts.late, color: "var(--warning)" },
    { label: "Leave", value: counts.leave, color: "var(--info)" },
    {
      label: "Holiday",
      value: counts.holiday,
      color: "var(--text-quaternary)",
    },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0);

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">This month · at a glance</h3>
        <span className="text-xs text-dim mono">{monthLabel}</span>
      </div>
      <div
        className="card-body"
        style={{ display: "flex", gap: 14, alignItems: "center" }}
      >
        <Donut parts={parts} total={total} size={120} />
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <Counter
            label="Days present"
            value={String(counts.present)}
            kind="accent"
          />
          <Counter
            label="Late arrivals"
            value={String(counts.late)}
            kind="warning"
          />
          <Counter
            label="Leave taken"
            value={String(counts.leave)}
            kind="info"
          />
          <Counter
            label="Overtime"
            value={`${overtimeHours.toFixed(1)}h`}
            kind="success"
          />
        </div>
      </div>
    </div>
  );
}

function Counter({
  label,
  value,
  kind,
}: {
  label: string;
  value: string;
  kind: "accent" | "warning" | "info" | "success";
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ fontSize: 12 }}
    >
      <span className="text-secondary">{label}</span>
      <span className={`pill pill-${kind}`}>{value}</span>
    </div>
  );
}

// SVG donut, ported from design/ui.jsx::Donut.
function Donut({
  parts,
  total,
  size,
}: {
  parts: { label: string; value: number; color: string }[];
  total: number;
  size: number;
}) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const safeTotal = total > 0 ? total : 1;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Month status breakdown"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--bg-sunken)"
        strokeWidth={16}
      />
      {parts.map((p, i) => {
        const dash = (p.value / safeTotal) * c;
        const el = (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={p.color}
            strokeWidth={16}
            strokeDasharray={`${dash} ${c - dash}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            strokeLinecap="butt"
          />
        );
        offset += dash;
        return el;
      })}
      <text
        x={size / 2}
        y={size / 2 - 2}
        textAnchor="middle"
        fontSize={20}
        fontFamily="var(--font-display)"
        fill="var(--text)"
        fontWeight={500}
      >
        {total}
      </text>
      <text
        x={size / 2}
        y={size / 2 + 14}
        textAnchor="middle"
        fontSize={9}
        fill="var(--text-tertiary)"
        fontFamily="var(--font-mono)"
        style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
      >
        total
      </text>
    </svg>
  );
}

// ----------------------------------------------------------------------
// Rolling 14 days row
// ----------------------------------------------------------------------

function Rolling14Row({
  item,
  onClick,
}: {
  item: AttendanceItem;
  onClick: () => void;
}) {
  const date = new Date(`${item.date}T00:00:00`);
  const inH = item.in_time ? parseHourFloat(item.in_time) : null;
  const outH = item.out_time ? parseHourFloat(item.out_time) : null;
  return (
    <button
      type="button"
      className="timeline-day"
      onClick={onClick}
      style={{
        appearance: "none",
        textAlign: "start",
        font: "inherit",
        background: "transparent",
        border: 0,
        borderBottom: "1px solid var(--border)",
        width: "100%",
        cursor: "pointer",
        padding: "10px 0",
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 14,
      }}
    >
      <div className="tl-date">
        <div className="tl-date-num">{date.getDate()}</div>
        <div>
          {date.toLocaleString(undefined, {
            month: "short",
            weekday: "short",
          })}
        </div>
      </div>
      <div>
        <div
          className="flex items-center justify-between"
          style={{ marginBottom: 6, flexWrap: "wrap", gap: 6 }}
        >
          <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
            <RecordStatusPill item={item} />
            {item.late && <span className="pill pill-warning">Late</span>}
            {item.early_out && (
              <span className="pill pill-warning">Early out</span>
            )}
            {item.short_hours && (
              <span className="pill pill-warning">Short</span>
            )}
            {item.overtime_minutes > 0 && (
              <span className="pill pill-accent">
                +{(item.overtime_minutes / 60).toFixed(1)}h OT
              </span>
            )}
          </div>
          <span className="mono text-xs text-dim">
            {item.in_time
              ? `${item.in_time.slice(0, 5)} → ${item.out_time?.slice(0, 5) ?? "—"}`
              : "—"}
          </span>
        </div>
        <DayRulerInline inH={inH} outH={outH} />
      </div>
    </button>
  );
}

function RecordStatusPill({ item }: { item: AttendanceItem }) {
  if (item.absent) return <span className="pill pill-danger">Absent</span>;
  if (item.late) return <span className="pill pill-warning">Late</span>;
  if (item.in_time)
    return <span className="pill pill-success">Present</span>;
  return <span className="pill pill-neutral">No record</span>;
}

// ----------------------------------------------------------------------
// Day timeline ribbon (Today card) + inline ruler (rolling 14)
// ----------------------------------------------------------------------

function DayRuler({ day }: { day: PersonDay | null }) {
  const inH = day?.in_time ? parseHourFloat(day.in_time) : null;
  const outH = day?.out_time ? parseHourFloat(day.out_time) : null;
  return <DayRulerInline inH={inH} outH={outH} />;
}

function DayRulerInline({
  inH,
  outH,
  policyIn = 7.5,
  policyOut = 16.5,
}: {
  inH: number | null;
  outH: number | null;
  policyIn?: number;
  policyOut?: number;
}) {
  const pct = (h: number) => `${(h / 24) * 100}%`;
  const widthPct = (a: number, b: number) =>
    `${((b - a) / 24) * 100}%`;
  return (
    <div className="day-ruler">
      {[6, 12, 18].map((h) => (
        <div
          key={h}
          className="day-ruler-hour"
          style={{ left: pct(h) }}
        />
      ))}
      {[0, 6, 12, 18, 24].map((h) => (
        <div
          key={h}
          className="day-ruler-tick-label"
          style={{ left: pct(h) }}
        >
          {String(h).padStart(2, "0")}
        </div>
      ))}
      <div
        className="day-ruler-policy"
        style={{
          left: pct(policyIn),
          width: widthPct(policyIn, policyOut),
        }}
      />
      {inH !== null && (
        <div
          className="day-ruler-session"
          style={{
            left: pct(inH),
            width: widthPct(inH, outH ?? Math.min(inH + 0.5, 24)),
          }}
        />
      )}
      {inH !== null && (
        <div className="day-ruler-event" style={{ left: pct(inH) }} />
      )}
      {outH !== null && (
        <div className="day-ruler-event" style={{ left: pct(outH) }} />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------

function CalendarLegend() {
  const items: { key: string; label: string; bg: string }[] = [
    { key: "present", label: "Present", bg: "var(--bg-elev)" },
    { key: "late", label: "Late", bg: "var(--warning-soft)" },
    { key: "leave", label: "Leave", bg: "var(--warning-soft)" },
    { key: "holiday", label: "Holiday", bg: "var(--accent-soft)" },
    { key: "weekend", label: "Weekend", bg: "var(--info-soft)" },
  ];
  return (
    <div
      className="flex items-center gap-3"
      style={{
        marginTop: 10,
        fontSize: 11,
        color: "var(--text-secondary)",
        flexWrap: "wrap",
      }}
    >
      {items.map((l) => (
        <span key={l.key} className="flex items-center gap-2">
          <span
            style={{
              width: 14,
              height: 14,
              background: l.bg,
              borderRadius: 3,
              border: "1px solid var(--border)",
            }}
          />
          {l.label}
        </span>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: CalendarStatus }) {
  const map: Record<
    CalendarStatus,
    { tone: string; label: string }
  > = {
    present: { tone: "success", label: "Present" },
    late: { tone: "warning", label: "Late" },
    absent: { tone: "danger", label: "Absent" },
    leave: { tone: "info", label: "Leave" },
    holiday: { tone: "neutral", label: "Holiday" },
    weekend: { tone: "neutral", label: "Weekend" },
    future: { tone: "neutral", label: "Upcoming" },
    no_record: { tone: "neutral", label: "No record" },
  };
  const m = map[status] ?? { tone: "neutral", label: status };
  return <span className={`pill pill-${m.tone}`}>{m.label}</span>;
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg-sunken)",
        borderRadius: 8,
      }}
    >
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 16, fontWeight: 500, marginTop: 2 }}
      >
        {value}
      </div>
      {sub && (
        <div className="text-xs text-dim" style={{ marginTop: 1 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function LegendDot({
  label,
  style,
}: {
  label: string;
  style: React.CSSProperties;
}) {
  return (
    <span className="flex items-center gap-2">
      <span style={{ display: "inline-block", ...style }} />
      {label}
    </span>
  );
}

function countStatuses(days: PersonDay[]): {
  present: number;
  late: number;
  leave: number;
  holiday: number;
  weekend: number;
  absent: number;
} {
  const acc = {
    present: 0,
    late: 0,
    leave: 0,
    holiday: 0,
    weekend: 0,
    absent: 0,
  };
  for (const d of days) {
    if (d.status === "present") acc.present += 1;
    else if (d.status === "late") acc.late += 1;
    else if (d.status === "leave") acc.leave += 1;
    else if (d.status === "holiday") acc.holiday += 1;
    else if (d.status === "weekend") acc.weekend += 1;
    else if (d.status === "absent") acc.absent += 1;
  }
  return acc;
}

function formatHoursColon(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseHourFloat(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((s) => parseInt(s, 10));
  return (h ?? 0) + (m ?? 0) / 60;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(yyyymm: string, delta: number): string {
  const [y, m] = yyyymm.split("-").map((s) => parseInt(s, 10));
  const d = new Date((y ?? 1970), (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthFromIso(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map((s) => parseInt(s, 10));
  const d = new Date(y ?? 1970, (m ?? 1) - 1, 1);
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}
