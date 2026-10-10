// "My attendance" — the employee's own attendance at a glance.
//
// Layout (desktop, Oct 2026 redesign):
//   header (greeting · policy · actions)
//   → Today hero (status, first in / last out, hours vs required,
//     late-by, shift window + 24h ribbon)
//   → month summary tiles (present / late / absent / on leave /
//     overtime) with the month navigator; clicking a tile highlights
//     those days on the mini calendar
//   → recent days table (left) + compact month calendar (right).
// Any day (table row or calendar cell) opens the existing P28.6
// DayDetailDrawer (camera evidence + day detail).
//
// Data sources — all existing GET endpoints, nothing invented:
//   * /api/employees/me            → the linked employee id
//   * /api/attendance/me/recent    → last 14 days (flags + server "today")
//   * /api/attendance/calendar/person/{id}?month=  → server-computed
//     day status for the viewed month (and the current month for Today)
//   * /api/attendance/calendar/day/{id}/{today}    → policy window +
//     required hours for the Today card
//
// Mounted at /my-attendance and /attendance/me.

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { extractApiError } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { EmptyPanel, StatCard, StatGrid } from "../../components/ListPageUi";
import { SkeletonCards, SkeletonLines, SkeletonTable } from "../../components/Skeleton";
import { NewRequestDrawer } from "../../requests/NewRequestDrawer";
import type { RequestType } from "../../requests/types";
import { Icon } from "../../shell/Icon";
import { DayDetailDrawer } from "../calendar/DayDetailDrawer";
import { calcLateMinutes } from "../calendar/PersonView";
import { DOW_KEYS, Legend, MonthNav, TONE } from "../calendar/calendarUi";
import type { SummaryKey } from "../calendar/calendarUi";
import { useDayDetail, usePersonCalendar } from "../calendar/hooks";
import type { CalendarStatus, DayDetail, PersonDay } from "../calendar/types";
import { useMyEmployee } from "../employees/hooks";
import { ATT_ICON, DotPill, StrokeIcon } from "./attendanceUi";
import type { DotTone } from "./attendanceUi";
import { useMyRecentAttendance, useRegenerateAttendanceForEmployee } from "./hooks";
import { formatMinutes, formatOvertime } from "./timeFormat";
import type { AttendanceItem } from "./types";

const RECENT_DAYS = 14;

type TileKey = "present" | "late" | "absent" | "leave" | "overtime";

export function MyAttendancePage() {
  const { t } = useTranslation();
  const me = useMe();
  const [month, setMonth] = useState<string>(currentMonth());
  const [drawerDate, setDrawerDate] = useState<string | null>(null);
  const [request, setRequest] = useState<{ type: RequestType; date?: string } | null>(null);
  const [highlight, setHighlight] = useState<TileKey | null>(null);

  // Requests can only be self-submitted under the Employee role
  // (POST /api/requests 403s otherwise), so the request CTAs only
  // render when the active role is Employee.
  const canRequest = (me.data?.roles ?? []).includes("Employee");

  // Backend resolves user → employee by lower-cased email match
  // (GET /api/employees/me). Returns null when the account isn't
  // linked to an employee row — Admin/HR accounts often aren't.
  const myEmployee = useMyEmployee();
  const employeeId = myEmployee.data?.id ?? null;
  const notLinked = employeeId === null && !myEmployee.isLoading;

  const recent = useMyRecentAttendance(RECENT_DAYS);
  // Tenant-local "today" from the server when known; browser date
  // only as a fallback before the first response lands.
  const todayDate = recent.data?.date ?? todayIso();
  const todayMonth = todayDate.slice(0, 7);

  const person = usePersonCalendar(employeeId, month);
  // Same query key as ``person`` while viewing the current month, so
  // this only costs a request after navigating to another month.
  const current = usePersonCalendar(employeeId, todayMonth);
  const todayDetail = useDayDetail(employeeId, employeeId !== null ? todayDate : null);

  const regen = useRegenerateAttendanceForEmployee();
  const [regenInfo, setRegenInfo] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

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
          void current.refetch();
          void todayDetail.refetch();
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

  const todayDay = current.data?.days.find((d) => d.date === todayDate) ?? null;
  const todayItem = recent.data?.items.find((i) => i.date === todayDate) ?? null;

  // Every PersonDay we have loaded, keyed by date — the recent table
  // prefers the calendar's server-computed status when it has one.
  const calByDate = useMemo(() => {
    const m = new Map<string, PersonDay>();
    for (const d of current.data?.days ?? []) m.set(d.date, d);
    for (const d of person.data?.days ?? []) m.set(d.date, d);
    return m;
  }, [current.data, person.data]);

  const recentRows = useMemo(() => {
    const byDate = new Map((recent.data?.items ?? []).map((i) => [i.date, i] as const));
    const rows: { date: string; item: AttendanceItem | null; day: PersonDay | null }[] = [];
    const end = new Date(`${todayDate}T00:00:00`);
    for (let i = 0; i < RECENT_DAYS; i += 1) {
      const d = new Date(end);
      d.setDate(end.getDate() - i);
      const iso = toIso(d);
      rows.push({ date: iso, item: byDate.get(iso) ?? null, day: calByDate.get(iso) ?? null });
    }
    return rows;
  }, [recent.data, calByDate, todayDate]);

  const policyName = todayDay?.policy_name ?? todayDetail.data?.policy_name ?? todayItem?.policy.name ?? null;
  const headerSub = policyName
    ? t("myAttendance.headerSubWithPolicy", { policy: policyName })
    : t("myAttendance.headerSub");

  const monthLabel = monthFromIso(month);

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
              {regen.isPending ? t("myAttendance.regenerating") : t("myAttendance.regenerate")}
            </button>
          )}
          {canRequest && (
            <>
              <button type="button" className="btn" onClick={() => setRequest({ type: "leave" })}>
                <Icon name="calendar" size={12} />
                {t("myAttendance.requestLeave", { defaultValue: "Request leave" })}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setRequest({ type: "exception", date: todayDate })}
              >
                <Icon name="plus" size={12} />
                {t("myAttendance.submitException", { defaultValue: "Submit exception" })}
              </button>
            </>
          )}
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

      {notLinked ? (
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
      ) : (
        <>
          {/* ---------- Today ---------- */}
          <TodayHero
            date={todayDate}
            day={todayDay}
            item={todayItem}
            detail={todayDetail.data ?? null}
            loading={myEmployee.isLoading || current.isLoading || (recent.isLoading && !todayDay)}
            error={current.isError ? extractApiError(current.error, t("myAttendance.calendarLoadFailed")) : null}
            onRetry={() => void current.refetch()}
            onOpen={employeeId !== null ? () => setDrawerDate(todayDate) : null}
          />

          {/* ---------- Month summary ---------- */}
          <div className="at-section-head at-me-section-head">
            <div>
              <h2 className="at-section-title">
                {t("myAttendance.summary.title", { month: monthLabel, defaultValue: "Month summary · {{month}}" })}
              </h2>
              <p className="at-section-sub">
                {t("myAttendance.summary.hint", {
                  defaultValue: "Counts up to today. Click a tile to highlight those days on the calendar.",
                })}
              </p>
            </div>
            <div className="at-row">
              {month !== todayMonth && (
                <button type="button" className="btn btn-sm" onClick={() => setMonth(todayMonth)}>
                  {t("myAttendance.calendar.today")}
                </button>
              )}
              <MonthNav month={month} onChange={setMonth} />
            </div>
          </div>

          {(myEmployee.isLoading || person.isLoading) && <SkeletonCards count={5} minWidth={180} />}
          {person.isError && (
            <div className="card at-me-block">
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
          {person.data && (
            <MonthTiles days={person.data.days} highlight={highlight} onHighlight={setHighlight} />
          )}

          {/* ---------- Recent days + mini calendar ---------- */}
          <div className="at-me-split">
            <RecentDaysCard
              rows={recentRows}
              loading={recent.isLoading}
              error={recent.isError ? extractApiError(recent.error, t("myAttendance.requestFailed")) : null}
              onRetry={() => void recent.refetch()}
              onOpen={employeeId !== null ? (iso) => setDrawerDate(iso) : null}
            />
            <div className="card at-me-cal">
              <div className="at-me-card-head">
                <div>
                  <h3 className="card-title">{monthLabel}</h3>
                  <p className="card-sub">{t("myAttendance.miniCal.hint", { defaultValue: "Click a day for detail and camera evidence" })}</p>
                </div>
              </div>
              {(myEmployee.isLoading || person.isLoading) && <SkeletonLines lines={6} />}
              {person.data && (
                <MiniCalendar
                  days={person.data.days}
                  todayDate={todayDate}
                  highlight={highlight}
                  onPick={(iso) => setDrawerDate(iso)}
                />
              )}
              {person.isError && (
                <p className="at-me-muted">{t("myAttendance.calendarLoadFailed")}</p>
              )}
              <Legend />
            </div>
          </div>
        </>
      )}

      {/* ---------- Drawers ---------- */}
      {employeeId !== null && drawerDate && (
        <DayDetailDrawer
          employeeId={employeeId}
          isoDate={drawerDate}
          onClose={() => setDrawerDate(null)}
          {...(canRequest && {
            onSubmitException: (iso: string) => {
              setDrawerDate(null);
              setRequest({ type: "exception", date: iso });
            },
          })}
        />
      )}

      {request && (
        <NewRequestDrawer
          initialType={request.type}
          {...(request.date ? { initialStartDate: request.date } : {})}
          onClose={() => setRequest(null)}
          onCreated={() => setRequest(null)}
        />
      )}
    </>
  );
}

// ----------------------------------------------------------------------
// Today hero
// ----------------------------------------------------------------------

function TodayHero({
  date,
  day,
  item,
  detail,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  date: string;
  day: PersonDay | null;
  item: AttendanceItem | null;
  detail: DayDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (() => void) | null;
}) {
  const { t, i18n } = useTranslation();
  const headerDate = new Date(`${date}T00:00:00`).toLocaleDateString(
    i18n.language === "ar" ? "ar-OM" : "en-GB",
    { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  );

  if (loading) {
    return (
      <div className="card at-me-hero">
        <SkeletonLines lines={4} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="card at-me-block">
        <EmptyPanel
          tone="danger"
          icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
          title={t("myAttendance.today.errorTitle", { defaultValue: "Couldn't load today" })}
          body={error}
          actions={
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" size={12} />
              {t("common.retry", { defaultValue: "Retry" })}
            </button>
          }
        />
      </div>
    );
  }

  const status: CalendarStatus | null = day?.status ?? (item ? statusFromItem(item) : null);
  const inTime = day?.in_time ?? item?.in_time ?? null;
  const outTime = day?.out_time ?? item?.out_time ?? null;
  const total = day?.total_minutes ?? item?.total_minutes ?? null;
  const overtime = day?.overtime_minutes ?? item?.overtime_minutes ?? 0;
  const onSite = !!inTime && !outTime;

  const requiredMin =
    detail?.policy_required_hours != null ? Math.round(detail.policy_required_hours * 60) : null;
  const shiftStart = detail?.policy_shift_start ?? day?.policy_shift_start ?? null;
  const grace = detail?.policy_grace_minutes ?? day?.policy_grace_minutes ?? null;
  const lateBy =
    (status === "late" || item?.late) && inTime && shiftStart && grace != null
      ? calcLateMinutes(inTime, shiftStart, grace)
      : null;

  const window = policyWindow(detail, (inW, outW) =>
    t("myAttendance.today.flexWindow", { inW, outW, defaultValue: "In {{inW}} · Out {{outW}}" }),
  );
  const policyName = day?.policy_name ?? detail?.policy_name ?? item?.policy.name ?? null;
  const progress = requiredMin && total != null ? Math.min(100, Math.round((total / requiredMin) * 100)) : null;

  const statusLine = inTime
    ? onSite
      ? t("myAttendance.today.onSite")
      : t("myAttendance.today.clockedOut")
    : t("myAttendance.today.noEvents");

  return (
    <section className="card at-me-hero" aria-label={t("myAttendance.today.aria", { defaultValue: "Today's attendance" })}>
      <div className="at-me-hero-main">
        <div className="at-me-hero-id">
          <span className="at-caption">{t("myAttendance.today.label", { defaultValue: "Today" })}</span>
          <div className="at-me-hero-date">{headerDate}</div>
          <div className="at-me-hero-status">
            {status ? <StatusPill status={status} day={day} /> : <DotPill tone="neutral">{t("myAttendance.statusPill.noRecord")}</DotPill>}
            {lateBy != null && lateBy > 0 && (
              <DotPill tone="warning">
                {t("myAttendance.lateBy", { value: formatMinutes(lateBy), defaultValue: "Late by {{value}}" })}
              </DotPill>
            )}
            {item?.early_out && <DotPill tone="warning">{t("myAttendance.rolling.earlyOut")}</DotPill>}
          </div>
          <p className="at-me-hero-note">{statusLine}</p>
        </div>

        <div className="at-me-hero-facts">
          <HeroFact
            label={t("myAttendance.today.firstIn", { defaultValue: "First in" })}
            value={inTime ? inTime.slice(0, 5) : "—"}
            sub={inTime ? t("myAttendance.today.earliestDetection") : t("myAttendance.today.notDetected")}
          />
          <HeroFact
            label={t("myAttendance.today.lastOut", { defaultValue: "Last out" })}
            value={outTime ? outTime.slice(0, 5) : "—"}
            sub={onSite ? t("myAttendance.today.stillOnSite") : outTime ? t("myAttendance.today.latestDetection") : "—"}
          />
          <HeroFact
            label={t("myAttendance.today.hours", { defaultValue: "Hours" })}
            value={total != null && total > 0 ? formatMinutes(total) : "—"}
            sub={
              requiredMin
                ? t("myAttendance.today.ofRequired", { value: formatMinutes(requiredMin), defaultValue: "of {{value}} required" })
                : t("myAttendance.today.noRequired", { defaultValue: "No required hours set" })
            }
          >
            {progress != null && (
              <span
                className="at-me-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                aria-label={t("myAttendance.today.progressAria", { defaultValue: "Hours against required" })}
              >
                <span className={`at-me-progress-bar${progress >= 100 ? " is-done" : ""}`} style={{ inlineSize: `${progress}%` }} />
              </span>
            )}
          </HeroFact>
          <HeroFact
            label={t("myAttendance.today.overtime")}
            value={overtime > 0 ? formatOvertime(overtime) : "0m"}
            sub={t("myAttendance.today.todaySub")}
          />
        </div>
      </div>

      <div className="at-me-hero-foot">
        <div className="at-me-shift">
          <Icon name="clock" size={13} />
          <span className="at-me-shift-name">
            {policyName ?? t("myAttendance.today.noPolicy", { defaultValue: "No shift policy resolved" })}
          </span>
          {window.label && <span className="at-me-shift-window mono">{window.label}</span>}
          {grace != null && grace > 0 && (
            <span className="at-me-muted">
              {t("myAttendance.today.grace", { value: grace, defaultValue: "{{value}} min grace" })}
            </span>
          )}
        </div>
        <div className="at-me-ruler-wrap">
          <DayRuler inTime={inTime} outTime={outTime} window={window} />
          <div className="at-legend at-me-ruler-legend">
            {window.from != null && (
              <span className="at-legend-item">
                <span className="at-legend-swatch is-policy" />
                {t("myAttendance.today.policyWindow")}
              </span>
            )}
            <span className="at-legend-item">
              <span className="at-legend-swatch is-session" />
              {t("myAttendance.today.onSiteLegend")}
            </span>
          </div>
        </div>
        {onOpen && (
          <button type="button" className="btn btn-sm" onClick={onOpen}>
            {t("myAttendance.today.viewDetail", { defaultValue: "View day detail" })}
            <Icon name="chevronRight" size={12} />
          </button>
        )}
      </div>
    </section>
  );
}

function HeroFact({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub: string;
  children?: ReactNode;
}) {
  return (
    <div className="at-me-fact">
      <div className="at-fact-label">{label}</div>
      <div className="at-me-fact-value">{value}</div>
      {children}
      <div className="at-fact-sub">{sub}</div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Month tiles
// ----------------------------------------------------------------------

function MonthTiles({
  days,
  highlight,
  onHighlight,
}: {
  days: PersonDay[];
  highlight: TileKey | null;
  onHighlight: (k: TileKey | null) => void;
}) {
  const { t } = useTranslation();
  const c = useMemo(() => countMonth(days), [days]);
  const toggle = (k: TileKey) => onHighlight(highlight === k ? null : k);
  // Attendance rate over scheduled working days only (worked weekends
  // are a bonus, not part of the denominator).
  const attended = c.presentWorking + c.late;
  const expected = attended + c.absent;
  const rate = expected > 0 ? Math.round((attended / expected) * 100) : null;

  return (
    <StatGrid>
      <StatCard
        tone="success"
        icon={ATT_ICON.present}
        label={t("myAttendance.tiles.present", { defaultValue: "Days present" })}
        value={c.present}
        sub={
          rate != null
            ? t("myAttendance.tiles.presentSub", { value: rate, defaultValue: "{{value}}% of working days attended" })
            : t("myAttendance.tiles.noWorkingDays", { defaultValue: "No working days yet" })
        }
        active={highlight === "present"}
        onClick={() => toggle("present")}
      />
      <StatCard
        tone="warning"
        icon={ATT_ICON.late}
        label={t("myAttendance.tiles.late", { defaultValue: "Late" })}
        value={c.late}
        sub={t("myAttendance.tiles.lateSub", { defaultValue: "Arrived after the grace period" })}
        active={highlight === "late"}
        onClick={() => toggle("late")}
      />
      <StatCard
        tone="danger"
        icon={ATT_ICON.absent}
        label={t("myAttendance.tiles.absent", { defaultValue: "Absent" })}
        value={c.absent}
        sub={t("myAttendance.tiles.absentSub", { defaultValue: "Working days with no attendance" })}
        active={highlight === "absent"}
        onClick={() => toggle("absent")}
      />
      <StatCard
        tone="info"
        icon={ATT_ICON.leave}
        label={t("myAttendance.tiles.leave", { defaultValue: "On leave" })}
        value={c.leave}
        sub={t("myAttendance.tiles.leaveSub", { defaultValue: "Approved leave days" })}
        active={highlight === "leave"}
        onClick={() => toggle("leave")}
      />
      {/* Same look as StatCard, but the value is a duration, which
          StatCard (number-only) can't render. */}
      <button
        type="button"
        onClick={() => toggle("overtime")}
        aria-pressed={highlight === "overtime"}
        className="mg-stat tone-neutral at-me-stat-ot"
      >
        <span className="mg-stat-top">
          <span className="mg-stat-label">{t("myAttendance.tiles.overtime", { defaultValue: "Overtime" })}</span>
          <span className="mg-stat-icon" aria-hidden>
            <StrokeIcon size={20}>{ATT_ICON.late}</StrokeIcon>
          </span>
        </span>
        <span className="mg-stat-value">{c.overtime > 0 ? formatMinutes(c.overtime) : "0m"}</span>
        <span className="mg-stat-sub">
          {c.overtimeDays === 0
            ? t("myAttendance.tiles.overtimeNone", { defaultValue: "No overtime this month" })
            : t("myAttendance.tiles.overtimeSub", {
                count: c.overtimeDays,
                defaultValue: c.overtimeDays === 1 ? "On {{count}} day" : "Across {{count}} days",
              })}
        </span>
      </button>
    </StatGrid>
  );
}

// ----------------------------------------------------------------------
// Recent days table
// ----------------------------------------------------------------------

function RecentDaysCard({
  rows,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  rows: { date: string; item: AttendanceItem | null; day: PersonDay | null }[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: ((iso: string) => void) | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === "ar" ? "ar-OM" : "en-GB";
  const hasAny = rows.some((r) => r.item || (r.day && r.day.status !== "no_record" && r.day.status !== "future"));

  return (
    <div className="card at-me-recent">
      <div className="at-me-card-head">
        <div>
          <h3 className="card-title">{t("myAttendance.recent.title", { defaultValue: "Last 14 days" })}</h3>
          <p className="card-sub">{t("myAttendance.recent.sub", { defaultValue: "Newest first · click a day for detail and camera evidence" })}</p>
        </div>
      </div>
      {loading && (
        <div className="at-me-pad">
          <SkeletonTable rows={7} cols={7} />
        </div>
      )}
      {error && !loading && (
        <EmptyPanel
          tone="danger"
          icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
          title={t("myAttendance.rolling.errorTitle", { defaultValue: "Couldn't load recent attendance" })}
          body={error}
          actions={
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" size={12} />
              {t("common.retry", { defaultValue: "Retry" })}
            </button>
          }
        />
      )}
      {!loading && !error && !hasAny && (
        <EmptyPanel
          icon={<StrokeIcon>{ATT_ICON.calendar}</StrokeIcon>}
          title={t("myAttendance.rolling.emptyTitle", { defaultValue: "No attendance yet" })}
          body={t("myAttendance.recent.emptyBody", {
            defaultValue: "Days appear here once the cameras record you. Check back after your first day on site.",
          })}
        />
      )}
      {!loading && !error && hasAny && (
        <div className="at-scroll-x">
          <table className="table at-me-table">
            <thead>
              <tr>
                <th scope="col">{t("myAttendance.recent.date", { defaultValue: "Date" })}</th>
                <th scope="col">{t("myAttendance.recent.status", { defaultValue: "Status" })}</th>
                <th scope="col">{t("myAttendance.recent.in", { defaultValue: "In" })}</th>
                <th scope="col">{t("myAttendance.recent.out", { defaultValue: "Out" })}</th>
                <th scope="col" className="at-me-num">{t("myAttendance.recent.hours", { defaultValue: "Hours" })}</th>
                <th scope="col" className="at-me-num">{t("myAttendance.recent.overtime", { defaultValue: "Overtime" })}</th>
                <th scope="col">{t("myAttendance.recent.flags", { defaultValue: "Flags" })}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ date, item, day }) => {
                const d = new Date(`${date}T00:00:00`);
                const status: CalendarStatus = day?.status ?? (item ? statusFromItem(item) : "no_record");
                const inTime = day?.in_time ?? item?.in_time ?? null;
                const outTime = day?.out_time ?? item?.out_time ?? null;
                const total = day?.total_minutes ?? item?.total_minutes ?? null;
                const ot = day?.overtime_minutes ?? item?.overtime_minutes ?? 0;
                const lateBy =
                  (status === "late" || item?.late) && inTime && day?.policy_shift_start && day.policy_grace_minutes != null
                    ? calcLateMinutes(inTime, day.policy_shift_start, day.policy_grace_minutes)
                    : null;
                const off = status === "weekend" || status === "holiday" || status === "leave";
                const dateLabel = d.toLocaleDateString(locale, { day: "numeric", month: "short" });
                const weekday = d.toLocaleDateString(locale, { weekday: "short" });
                return (
                  <tr
                    key={date}
                    className={`${onOpen ? "at-row-clickable" : ""}${off ? " at-me-row-off" : ""}`}
                    onClick={onOpen ? () => onOpen(date) : undefined}
                  >
                    <td>
                      {onOpen ? (
                        <button
                          type="button"
                          className="at-me-date-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(date);
                          }}
                          aria-label={t("myAttendance.recent.openDay", { date: `${weekday} ${dateLabel}`, defaultValue: "Open {{date}}" })}
                        >
                          <span className="at-me-date">{dateLabel}</span>
                          <span className="at-me-weekday">{weekday}</span>
                        </button>
                      ) : (
                        <span className="at-me-date-btn">
                          <span className="at-me-date">{dateLabel}</span>
                          <span className="at-me-weekday">{weekday}</span>
                        </span>
                      )}
                    </td>
                    <td><StatusPill status={status} day={day} /></td>
                    <td className="mono">{inTime ? inTime.slice(0, 5) : <span className="at-me-muted">—</span>}</td>
                    <td className="mono">{outTime ? outTime.slice(0, 5) : <span className="at-me-muted">—</span>}</td>
                    <td className="mono at-me-num">{total != null && total > 0 ? formatMinutes(total) : <span className="at-me-muted">—</span>}</td>
                    <td className="mono at-me-num">{ot > 0 ? formatOvertime(ot) : <span className="at-me-muted">—</span>}</td>
                    <td>
                      <span className="at-me-flags">
                        {lateBy != null && lateBy > 0 && (
                          <span className="pill pill-warning">
                            {t("myAttendance.lateBy", { value: formatMinutes(lateBy), defaultValue: "Late by {{value}}" })}
                          </span>
                        )}
                        {item?.early_out && <span className="pill pill-warning">{t("myAttendance.rolling.earlyOut")}</span>}
                        {item?.short_hours && <span className="pill pill-warning">{t("myAttendance.rolling.short")}</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Mini month calendar (Calendar page colours via calendarUi.TONE)
// ----------------------------------------------------------------------

function MiniCalendar({
  days,
  todayDate,
  highlight,
  onPick,
}: {
  days: PersonDay[];
  todayDate: string;
  highlight: TileKey | null;
  onPick: (iso: string) => void;
}) {
  const { t } = useTranslation();
  const first = days[0] ? new Date(`${days[0].date}T00:00:00`) : null;
  const lead = first ? first.getDay() : 0;

  return (
    <div className="at-me-mini" role="grid" aria-label={t("myAttendance.miniCal.aria", { defaultValue: "Month calendar" })}>
      <div className="at-me-mini-row" role="row">
        {DOW_KEYS.map((k) => (
          <span key={k} role="columnheader" className="at-me-mini-dow">
            {t(`calendar.dow.${k}`) as string}
          </span>
        ))}
      </div>
      <div className="at-me-mini-grid" role="row">
        {Array.from({ length: lead }).map((_, i) => (
          <span key={`pad-${i}`} aria-hidden className="at-me-mini-pad" />
        ))}
        {days.map((d) => {
          const key = summaryKey(d);
          const tone = key ? TONE[key] : null;
          const future = d.status === "future";
          const matches = highlight === null || matchesTile(d, highlight);
          const label = [
            d.date,
            t(`calendar.status.${d.status}`) as string,
            d.in_time ? `${d.in_time.slice(0, 5)}${d.out_time ? `–${d.out_time.slice(0, 5)}` : ""}` : null,
            d.holiday_name ?? null,
            d.leave_name ?? null,
          ]
            .filter(Boolean)
            .join(" · ");
          const cls = [
            "at-me-mini-day",
            d.date === todayDate && "is-today",
            future && "is-future",
            !matches && "is-dim",
            highlight !== null && matches && "is-hit",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={d.date}
              type="button"
              role="gridcell"
              className={cls}
              disabled={future}
              onClick={future ? undefined : () => onPick(d.date)}
              title={label}
              aria-label={label}
              style={tone ? { background: tone.soft, color: tone.fg } : undefined}
            >
              <span className="at-me-mini-num">{parseInt(d.date.slice(8, 10), 10)}</span>
              {tone && key !== "weekend" && (
                <span aria-hidden className="at-me-mini-dot" style={{ background: tone.dot }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Day ribbon (24h) — policy window + on-site span
// ----------------------------------------------------------------------

function DayRuler({
  inTime,
  outTime,
  window,
}: {
  inTime: string | null;
  outTime: string | null;
  window: { from: number | null; to: number | null };
}) {
  const inH = inTime ? parseHourFloat(inTime) : null;
  const outH = outTime ? parseHourFloat(outTime) : null;
  const pct = (h: number) => `${(h / 24) * 100}%`;
  const widthPct = (a: number, b: number) => `${(Math.max(0, b - a) / 24) * 100}%`;
  return (
    <div className="day-ruler" aria-hidden>
      {[6, 12, 18].map((h) => (
        <div key={h} className="day-ruler-hour" style={{ insetInlineStart: pct(h) }} />
      ))}
      {/* 00 / 24 sit on the clipped edges, so only interior ticks get labels. */}
      {[6, 12, 18].map((h) => (
        <div key={h} className="day-ruler-tick-label" style={{ insetInlineStart: pct(h) }}>
          {String(h).padStart(2, "0")}
        </div>
      ))}
      {window.from != null && window.to != null && window.to > window.from && (
        <div
          className="day-ruler-policy"
          style={{ insetInlineStart: pct(window.from), width: widthPct(window.from, window.to) }}
        />
      )}
      {/* Overnight window (end before start): paint start→24 and 0→end. */}
      {window.from != null && window.to != null && window.to <= window.from && (
        <>
          <div className="day-ruler-policy" style={{ insetInlineStart: pct(window.from), width: widthPct(window.from, 24) }} />
          <div className="day-ruler-policy" style={{ insetInlineStart: pct(0), width: widthPct(0, window.to) }} />
        </>
      )}
      {inH !== null && (
        <div
          className="day-ruler-session"
          style={{ insetInlineStart: pct(inH), width: widthPct(inH, outH ?? Math.min(inH + 0.5, 24)) }}
        />
      )}
      {inH !== null && <div className="day-ruler-event" style={{ insetInlineStart: pct(inH) }} />}
      {outH !== null && <div className="day-ruler-event" style={{ insetInlineStart: pct(outH) }} />}
    </div>
  );
}

// ----------------------------------------------------------------------
// Status pill
// ----------------------------------------------------------------------

function StatusPill({ status, day }: { status: CalendarStatus; day: PersonDay | null }) {
  const { t } = useTranslation();
  if (status === "holiday") {
    return (
      <span className="at-pill at-me-pill-holiday" title={day?.holiday_name ?? undefined}>
        <span aria-hidden className="at-pill-dot" />
        <span className="at-pill-text">{day?.holiday_name || t("myAttendance.statusPill.holiday")}</span>
      </span>
    );
  }
  // Worked on a weekend → the Calendar page shows it as Present.
  if (status === "weekend" && day?.in_time) {
    return <DotPill tone="success">{t("myAttendance.statusPill.present")}</DotPill>;
  }
  const map: Record<Exclude<CalendarStatus, "holiday">, { tone: DotTone; label: string }> = {
    present: { tone: "success", label: t("myAttendance.statusPill.present") },
    escalation_present: { tone: "accent", label: t("myAttendance.statusPill.escalation") },
    late: { tone: "warning", label: t("myAttendance.statusPill.late") },
    absent: { tone: "danger", label: t("myAttendance.statusPill.absent") },
    // Today-only: shift window still open + no in_time yet. Distinct
    // from absent so staff who can still arrive aren't flagged.
    waiting: { tone: "accent", label: t("myAttendance.statusPill.waiting") },
    leave: { tone: "info", label: t("myAttendance.status.onLeave", { defaultValue: "On leave" }) },
    weekend: { tone: "neutral", label: t("myAttendance.statusPill.weekend") },
    future: { tone: "neutral", label: t("myAttendance.statusPill.upcoming") },
    no_record: { tone: "neutral", label: t("myAttendance.statusPill.noRecord") },
  };
  const m = map[status] ?? { tone: "neutral" as DotTone, label: status };
  return (
    <DotPill tone={m.tone} {...(status === "leave" && day?.leave_name ? { title: day.leave_name } : {})}>
      {m.label}
    </DotPill>
  );
}

// ----------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------

/** Status for a /me/recent row when no calendar day is loaded for that
 *  date — mirrors the calendar's precedence (leave > weekend/holiday
 *  without a check-in > waiting > absent > late > present). */
function statusFromItem(it: AttendanceItem): CalendarStatus {
  if (it.leave_type_id !== null) return "leave";
  if (!it.in_time) {
    if (it.is_holiday) return "holiday";
    if (it.is_weekend) return "weekend";
    if (it.pending) return "waiting";
    if (it.absent) return "absent";
    return "no_record";
  }
  if (it.late) return "late";
  return "present";
}

function summaryKey(d: PersonDay): SummaryKey | null {
  switch (d.status) {
    case "present":
    case "escalation_present":
      return "present";
    case "late":
      return "late";
    case "absent":
      return "absent";
    case "leave":
      return "leave";
    case "holiday":
      return "holiday";
    case "weekend":
      return d.in_time ? "present" : "weekend";
    default:
      return null;
  }
}

function matchesTile(d: PersonDay, k: TileKey): boolean {
  if (k === "overtime") return d.overtime_minutes > 0;
  if (k === "present") return isPresentDay(d);
  return d.status === k;
}

/** Same rule as the Calendar page's person summary: a worked weekend
 *  counts as a present day. */
function isPresentDay(d: PersonDay): boolean {
  return d.status === "present" || d.status === "escalation_present" || (d.status === "weekend" && !!d.in_time);
}

function countMonth(days: PersonDay[]) {
  const acc = { present: 0, presentWorking: 0, late: 0, absent: 0, leave: 0, overtime: 0, overtimeDays: 0 };
  for (const d of days) {
    if (isPresentDay(d)) {
      acc.present += 1;
      if (d.status !== "weekend") acc.presentWorking += 1;
    }
    else if (d.status === "late") acc.late += 1;
    else if (d.status === "absent") acc.absent += 1;
    else if (d.status === "leave") acc.leave += 1;
    if (d.overtime_minutes > 0) {
      acc.overtime += d.overtime_minutes;
      acc.overtimeDays += 1;
    }
  }
  return acc;
}

/** Policy window for the ribbon + the "07:30–15:30" label. Fixed /
 *  Ramadan / Custom-fixed → shift start–end; Flex → in-window start to
 *  out-window end. Nothing is assumed when the API returns no times. */
function policyWindow(
  detail: DayDetail | null,
  flexLabel: (inW: string, outW: string) => string,
): { from: number | null; to: number | null; label: string | null } {
  if (!detail) return { from: null, to: null, label: null };
  const hm = (s: string | null | undefined) => (s ? s.slice(0, 5) : null);
  if (detail.policy_shift_start && detail.policy_shift_end) {
    return {
      from: parseHourFloat(detail.policy_shift_start),
      to: parseHourFloat(detail.policy_shift_end),
      label: `${hm(detail.policy_shift_start)}–${hm(detail.policy_shift_end)}`,
    };
  }
  if (detail.policy_in_window_start && detail.policy_out_window_end) {
    const inW = `${hm(detail.policy_in_window_start)}–${hm(detail.policy_in_window_end) ?? "?"}`;
    const outW = `${hm(detail.policy_out_window_start) ?? "?"}–${hm(detail.policy_out_window_end)}`;
    return {
      from: parseHourFloat(detail.policy_in_window_start),
      to: parseHourFloat(detail.policy_out_window_end),
      label: flexLabel(inW, outW),
    };
  }
  return { from: null, to: null, label: null };
}

function parseHourFloat(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((s) => parseInt(s, 10));
  return (h ?? 0) + (m ?? 0) / 60;
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayIso(): string {
  return toIso(new Date());
}

function currentMonth(): string {
  return todayIso().slice(0, 7);
}

function monthFromIso(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map((s) => parseInt(s, 10));
  const d = new Date(y ?? 1970, (m ?? 1) - 1, 1);
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}
