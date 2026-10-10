// "My attendance" — self-view ported from frontend/src/design/employee.jsx
// (the EmployeeDashboard component). Layout: header → today + month
// donut → clickable month calendar → rolling 14-day timeline. The
// calendar's day click opens DayDetailDrawer (camera evidence + day
// detail) — the existing P28.6 drawer already covers the "camera
// events tab + attendance details" surface the prompt asked for.
//
// Mounted at /my-attendance and /attendance/me, and re-exported by
// EmployeeDashboard so the Employee role's dashboard is this page.

import { EmptyPanel } from "../../components/ListPageUi";
import { ATT_ICON, DotPill, FieldCaption, StrokeIcon } from "./attendanceUi";
import type { DotTone } from "./attendanceUi";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { extractApiError } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { Icon } from "../../shell/Icon";
import { NewRequestDrawer } from "../../requests/NewRequestDrawer";
import { DayDetailDrawer } from "../calendar/DayDetailDrawer";
import { PersonView } from "../calendar/PersonView";
import { usePersonCalendar } from "../calendar/hooks";
import type { CalendarStatus, PersonDay } from "../calendar/types";
import { useMyEmployee } from "../employees/hooks";
import { useMyRecentAttendance, useRegenerateAttendanceForEmployee } from "./hooks";
import { formatMinutes } from "./timeFormat";
import type { AttendanceItem } from "./types";
import { SkeletonCalendar, SkeletonLines } from "../../components/Skeleton";

export function MyAttendancePage() {
  const { t } = useTranslation();
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
  const regen = useRegenerateAttendanceForEmployee();
  const [regenInfo, setRegenInfo] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);

  const triggerRegen = () => {
    if (employeeId === null) return;
    setRegenInfo(null);
    regen.mutate(
      { employee_id: employeeId },
      {
        onSuccess: (resp) => {
          setRegenInfo({
            tone: "ok",
            text: resp.upserted
              ? t("myAttendance.regenRefreshed", { date: resp.date })
              : t("myAttendance.regenNoPolicy", { date: resp.date }),
          });
        },
        onError: (err) => {
          setRegenInfo({
            tone: "err",
            text: t("myAttendance.regenFailed", {
              message: extractApiError(err, t("myAttendance.requestFailed")),
            }),
          });
        },
      },
    );
  };

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
      ? t("myAttendance.headerSubWithPolicy", { policy: policyName })
      : t("myAttendance.headerSub");
  }, [todayDay?.policy_name, t]);

  return (
    <>
      {/* ---------- Page header ---------- */}
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data?.full_name
              ? t("myAttendance.greeting", { name: firstName(me.data.full_name) })
              : t("myAttendance.title")}
          </h1>
          <p className="page-sub">{headerSub}</p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/my-profile">
            <Icon name="upload" size={12} />
            {t("myAttendance.updatePhoto")}
          </Link>
          {employeeId !== null && (
            <button
              type="button"
              className="btn"
              onClick={triggerRegen}
              disabled={regen.isPending}
              title={t("myAttendance.regenTooltip")}
            >
              <Icon name="refresh" size={12} />
              {regen.isPending
                ? t("myAttendance.regenerating")
                : t("myAttendance.regenerate")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setRequestOpen(true)}
          >
            <Icon name="plus" size={12} />
            {t("myAttendance.submitRequest")}
          </button>
        </div>
      </div>

      {regenInfo && (
        <div className={`at-notice tone-${regenInfo.tone === "ok" ? "info" : "danger"}`} role="status">
          <span className="at-notice-text">{regenInfo.text}</span>
          <button
            type="button"
            className="at-notice-close"
            onClick={() => setRegenInfo(null)}
            aria-label={t("common.close", { defaultValue: "Close" })}
          >
            ×
          </button>
        </div>
      )}

      {/* ---------- Today + at-a-glance ---------- */}
      <div className="at-today-grid">
        <TodayCard day={todayDay} loading={person.isLoading} />
        <AtAGlanceCard
          days={person.data?.days ?? []}
          monthLabel={monthLabel}
        />
      </div>

      {/* ---------- Month calendar (clickable) ---------- */}
      <div className="at-stack" style={{ marginBottom: 16, gap: 10 }}>
        <div className="at-section-head">
          <div>
            <h3 className="at-section-title">
              {t("myAttendance.calendar.title", { month: monthLabel })}
            </h3>
            <p className="at-section-sub">
              {t("myAttendance.calendar.hint")}
            </p>
          </div>
          <div className="at-row">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label={t("myAttendance.calendar.prevMonth")}
            >
              <Icon name="chevronLeft" size={13} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setMonth(currentMonth())}
            >
              {t("myAttendance.calendar.today")}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMonth(shiftMonth(month, 1))}
              aria-label={t("myAttendance.calendar.nextMonth")}
            >
              <Icon name="chevronRight" size={13} />
            </button>
          </div>
        </div>
        {employeeId === null && myEmployee.isLoading && <SkeletonCalendar />}
        {employeeId === null && !myEmployee.isLoading && (
          <div className="card">
            <EmptyPanel
              tone="accent"
              icon={<StrokeIcon>{ATT_ICON.face}</StrokeIcon>}
              title={t("myAttendance.noEmployeeLinkedTitle", { defaultValue: "No employee record linked" })}
              body={t("myAttendance.noEmployeeLinked")}
              actions={
                <Link className="btn" to="/my-profile">
                  <Icon name="user" size={12} />
                  {t("myAttendance.viewProfile", { defaultValue: "View my profile" })}
                </Link>
              }
            />
          </div>
        )}
        {employeeId !== null && person.isLoading && <SkeletonCalendar />}
        {employeeId !== null && person.isError && (
          <div className="card">
            <EmptyPanel
              tone="danger"
              icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
              title={t("myAttendance.calendarErrorTitle", { defaultValue: "Couldn't load your calendar" })}
              body={extractApiError(person.error, t("myAttendance.calendarLoadFailed"))}
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
            <h3 className="card-title">{t("myAttendance.rolling.title")}</h3>
            <p className="card-sub">{t("myAttendance.rolling.subtitle")}</p>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          {recent.isLoading && (
            <SkeletonLines lines={5} />
          )}
          {recent.isError && !recent.isLoading && (
            <EmptyPanel
              tone="danger"
              icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
              title={t("myAttendance.rolling.errorTitle", { defaultValue: "Couldn't load recent attendance" })}
              body={extractApiError(recent.error, t("myAttendance.requestFailed"))}
              actions={
                <button type="button" className="btn" onClick={() => void recent.refetch()}>
                  <Icon name="refresh" size={12} />
                  {t("common.retry", { defaultValue: "Retry" })}
                </button>
              }
            />
          )}
          {!recent.isLoading && !recent.isError && recentSorted.length === 0 && (
            <div className="at-inline-empty">
              <StrokeIcon size={20}>{ATT_ICON.calendar}</StrokeIcon>
              <span>{t("myAttendance.rolling.empty")}</span>
            </div>
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
  const { t } = useTranslation();
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
      ? formatMinutes(day.total_minutes)
      : "—";

  const otLabel =
    day && day.overtime_minutes > 0
      ? formatMinutes(day.overtime_minutes)
      : "0m";

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">{t("myAttendance.today.header", { date: headerDate })}</h3>
          <p className="card-sub">
            {day?.in_time
              ? onSite
                ? t("myAttendance.today.onSite")
                : t("myAttendance.today.clockedOut")
              : t("myAttendance.today.noEvents")}
          </p>
        </div>
        {day && <StatusPill status={day.status} />}
      </div>
      <div className="card-body">
        {loading && <SkeletonLines lines={5} />}
        {!loading && (
          <>
            <div className="at-facts" style={{ marginBottom: 16 }}>
              <Tile
                label={t("myAttendance.today.inTime")}
                value={day?.in_time?.slice(0, 8) ?? "—"}
                sub={day?.in_time ? t("myAttendance.today.earliestDetection") : t("myAttendance.today.notDetected")}
              />
              <Tile
                label={t("myAttendance.today.outTime")}
                value={day?.out_time?.slice(0, 8) ?? "—"}
                sub={
                  onSite
                    ? t("myAttendance.today.stillOnSite")
                    : day?.out_time
                      ? t("myAttendance.today.latestDetection")
                      : "—"
                }
              />
              <Tile label={t("myAttendance.today.total")} value={totalLabel} sub={t("myAttendance.today.hoursSinceIn")} />
              <Tile label={t("myAttendance.today.overtime")} value={otLabel} sub={t("myAttendance.today.todaySub")} />
            </div>
            <div style={{ marginBottom: 6 }}>
              <FieldCaption>{t("myAttendance.today.dayTimeline")}</FieldCaption>
            </div>
            <DayRuler day={day} />
            <div className="at-legend" style={{ marginTop: 10 }}>
              <span className="at-legend-item">
                <span className="at-legend-swatch is-policy" />
                {t("myAttendance.today.policyWindow")}
              </span>
              <span className="at-legend-item">
                <span className="at-legend-swatch is-session" />
                {t("myAttendance.today.onSiteLegend")}
              </span>
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
  const { t } = useTranslation();
  const counts = useMemo(() => countStatuses(days), [days]);
  const overtimeMinutes = useMemo(
    () => days.reduce((s, d) => s + (d.overtime_minutes ?? 0), 0),
    [days],
  );

  const parts = [
    { label: t("myAttendance.glance.present"), value: counts.present, color: "var(--accent)" },
    { label: t("myAttendance.glance.late"), value: counts.late, color: "var(--warning)" },
    { label: t("myAttendance.glance.leave"), value: counts.leave, color: "var(--info)" },
    {
      label: t("myAttendance.glance.holiday"),
      value: counts.holiday,
      color: "var(--text-quaternary)",
    },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0);

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{t("myAttendance.glance.title")}</h3>
        <span className="text-xs text-dim">{monthLabel}</span>
      </div>
      <div className="card-body at-glance">
        <Donut parts={parts} total={total} size={120} totalLabel={t("myAttendance.glance.totalLabel")} />
        <div className="at-glance-list">
          <Counter
            label={t("myAttendance.glance.daysPresent")}
            value={String(counts.present)}
            kind="accent"
          />
          <Counter
            label={t("myAttendance.glance.lateArrivals")}
            value={String(counts.late)}
            kind="warning"
          />
          <Counter
            label={t("myAttendance.glance.leaveTaken")}
            value={String(counts.leave)}
            kind="info"
          />
          <Counter
            label={t("myAttendance.glance.overtime")}
            value={overtimeMinutes > 0 ? formatMinutes(overtimeMinutes) : "0m"}
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
    <div className="at-glance-row">
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
  totalLabel,
}: {
  parts: { label: string; value: number; color: string }[];
  total: number;
  size: number;
  totalLabel: string;
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
      aria-label={totalLabel}
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
        fontFamily="var(--font-num)"
        style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
      >
        {totalLabel}
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
  const { t } = useTranslation();
  const date = new Date(`${item.date}T00:00:00`);
  const inH = item.in_time ? parseHourFloat(item.in_time) : null;
  const outH = item.out_time ? parseHourFloat(item.out_time) : null;
  return (
    <button
      type="button"
      className="timeline-day at-roll-row"
      onClick={onClick}
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
        <div className="at-roll-head">
          <div className="at-roll-pills">
            <RecordStatusPill item={item} />
            {item.late && <span className="pill pill-warning">{t("myAttendance.rolling.late")}</span>}
            {item.early_out && (
              <span className="pill pill-warning">{t("myAttendance.rolling.earlyOut")}</span>
            )}
            {item.short_hours && (
              <span className="pill pill-warning">{t("myAttendance.rolling.short")}</span>
            )}
            {item.overtime_minutes > 0 && (
              <span className="pill pill-accent">
                {t("myAttendance.rolling.otSuffix", { value: formatMinutes(item.overtime_minutes) })}
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
  const { t } = useTranslation();
  if (item.absent) return <DotPill tone="danger">{t("myAttendance.statusPill.absent")}</DotPill>;
  if (item.late) return <DotPill tone="warning">{t("myAttendance.statusPill.late")}</DotPill>;
  if (item.in_time)
    return <DotPill tone="success">{t("myAttendance.statusPill.present")}</DotPill>;
  return <DotPill tone="neutral">{t("myAttendance.statusPill.noRecord")}</DotPill>;
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
          style={{ insetInlineStart: pct(h) }}
        />
      ))}
      {[0, 6, 12, 18, 24].map((h) => (
        <div
          key={h}
          className="day-ruler-tick-label"
          style={{ insetInlineStart: pct(h) }}
        >
          {String(h).padStart(2, "0")}
        </div>
      ))}
      <div
        className="day-ruler-policy"
        style={{
          insetInlineStart: pct(policyIn),
          width: widthPct(policyIn, policyOut),
        }}
      />
      {inH !== null && (
        <div
          className="day-ruler-session"
          style={{
            insetInlineStart: pct(inH),
            width: widthPct(inH, outH ?? Math.min(inH + 0.5, 24)),
          }}
        />
      )}
      {inH !== null && (
        <div className="day-ruler-event" style={{ insetInlineStart: pct(inH) }} />
      )}
      {outH !== null && (
        <div className="day-ruler-event" style={{ insetInlineStart: pct(outH) }} />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------

function CalendarLegend() {
  const { t } = useTranslation();
  const items: { key: string; label: string; bg: string }[] = [
    { key: "present", label: t("myAttendance.statusPill.present"), bg: "var(--bg-elev)" },
    { key: "late", label: t("myAttendance.statusPill.late"), bg: "var(--warning-soft)" },
    { key: "leave", label: t("myAttendance.glance.leave"), bg: "var(--warning-soft)" },
    { key: "holiday", label: t("myAttendance.glance.holiday"), bg: "var(--accent-soft)" },
    { key: "weekend", label: t("myAttendance.statusPill.weekend"), bg: "var(--info-soft)" },
  ];
  return (
    <div className="at-legend">
      {items.map((l) => (
        <span key={l.key} className="at-legend-item">
          <span className="at-legend-swatch" style={{ background: l.bg }} />
          {l.label}
        </span>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: CalendarStatus }) {
  const { t } = useTranslation();
  const map: Record<
    CalendarStatus,
    { tone: DotTone; label: string }
  > = {
    present: { tone: "success", label: t("myAttendance.statusPill.present") },
    escalation_present: { tone: "accent", label: t("myAttendance.statusPill.escalation") },
    late: { tone: "warning", label: t("myAttendance.statusPill.late") },
    absent: { tone: "danger", label: t("myAttendance.statusPill.absent") },
    // Today-only: shift window still open + no in_time yet. Distinct
    // from absent so the operator doesn't flag staff who can still
    // arrive on time.
    waiting: { tone: "accent", label: t("myAttendance.statusPill.waiting") },
    leave: { tone: "info", label: t("myAttendance.statusPill.leave") },
    holiday: { tone: "neutral", label: t("myAttendance.statusPill.holiday") },
    weekend: { tone: "neutral", label: t("myAttendance.statusPill.weekend") },
    future: { tone: "neutral", label: t("myAttendance.statusPill.upcoming") },
    no_record: { tone: "neutral", label: t("myAttendance.statusPill.noRecord") },
  };
  const m = map[status] ?? { tone: "neutral" as DotTone, label: status };
  return <DotPill tone={m.tone}>{m.label}</DotPill>;
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
    <div>
      <div className="at-fact-label">{label}</div>
      <div className="at-fact-value">{value}</div>
      {sub && <div className="at-fact-sub">{sub}</div>}
    </div>
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
