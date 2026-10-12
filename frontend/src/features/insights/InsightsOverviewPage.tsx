// MaugoodAI Insights — Attendance overview (/insights), v2.
//
// Reads top-down like a briefing: header (range, department, PDF) →
// four headline metrics, each with plain-language context and a
// comparison to the previous period → key findings (computed sentences)
// → charts that each answer one question (is attendance holding up? are
// people on time? which weekday is weakest?) → who needs a follow-up →
// how departments compare → day-by-day exceptions.
//
// Every figure comes from GET /api/insights/overview, which reuses the
// PDF context builders — the dashboard and the PDF always agree.

import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { useMe } from "../../auth/AuthProvider";
import { FilterSelect } from "../../components/ListPageUi";
import { Icon } from "../../shell/Icon";
import { useDepartments } from "../departments/hooks";
import { useInsightsOverview } from "./hooks";
import type { InsightsRange } from "./hooks";
import {
  AttendanceTrendChart,
  ArrivalChart,
  ChartSkeleton,
  DepartmentCompareTable,
  DownloadPdfButton,
  ExceptionsTable,
  HeadlineMetric,
  HeadlineRow,
  HeadlineSkeleton,
  InsightsError,
  InsightsNotice,
  KeyFindings,
  MiniStats,
  Panel,
  PanelEmpty,
  QuestionTitle,
  RangePicker,
  ScopeChip,
  WatchlistPanel,
  WeekdayChart,
  addDays,
  clockDelta,
  clockToMinutes,
  deltaOf,
  fmtNum,
  fmtPct,
  minutesToClock,
  rangeQuery,
  useDurationFmt,
  useInsightsRange,
  useStatusLabel,
} from "./insightsUi";
import type { Finding, HeadlineComparison } from "./insightsUi";
import type { InsightsOverview, InsightsWeekday } from "./types";

const CONTEXT_DAYS = 14;
const K = "insights.overview";

/** Derived headline figures with v1 fallbacks (fields that may be absent). */
function headline(d: InsightsOverview) {
  const k = d.kpis;
  const expected = k.expected_days ?? k.total * Math.max(1, d.period.working_days);
  const presentDays = k.present_days ?? k.present;
  const attendance = k.attendance_pct ?? k.present_pct;
  const punctuality =
    k.punctuality_pct !== undefined ? k.punctuality_pct : presentDays > 0 ? ((presentDays - k.late) / presentDays) * 100 : null;
  return { expected, presentDays, attendance, punctuality, avgIn: k.avg_in ?? null };
}

export function InsightsOverviewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { range, preset, setRange } = useInsightsRange();
  const me = useMe();
  const departments = useDepartments();
  const dur = useDurationFmt();
  const statusLabel = useStatusLabel();

  const rawDept = params.get("department_id");
  const departmentId = rawDept && /^\d+$/.test(rawDept) ? Number(rawDept) : null;
  const setDepartment = (v: string) => {
    setParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (v) sp.set("department_id", v);
      else sp.delete("department_id");
      return sp;
    });
  };

  const q = useInsightsOverview(range, departmentId);
  const data = q.data;
  // A single day can't show a trend or a weekday pattern — chart the 14
  // days ending on that day instead (same endpoint, same numbers).
  const singleRange = range.start === range.end;
  const contextRange: InsightsRange = singleRange ? { start: addDays(range.end, -(CONTEXT_DAYS - 1)), end: range.end } : range;
  const ctxQ = useInsightsOverview(contextRange, departmentId);
  const chartSrc = singleRange ? ctxQ.data : data;

  const [excStatus, setExcStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [range.start, range.end, departmentId, excStatus]);
  useEffect(() => setExcStatus(""), [range.start, range.end, departmentId]);

  const deptOptions = useMemo<Array<[string, string]>>(() => {
    const all = departments.data?.items ?? [];
    const isManagerOnly = me.data?.active_role === "Manager";
    const allowed = isManagerOnly ? new Set(me.data?.departments ?? []) : null;
    const items = all
      .filter((d) => !allowed || allowed.has(d.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => [String(d.id), d.name] as [string, string]);
    return [["", t("insights.filter.allDepartments", { defaultValue: "All departments" })], ...items];
  }, [departments.data, me.data, t]);

  const exceptions = data?.exceptions ?? [];
  const excStatuses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of exceptions) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [exceptions]);
  const filteredExceptions = excStatus ? exceptions.filter((e) => e.status === excStatus) : exceptions;

  const rq = rangeQuery(range);
  const openPerson = (id: number) => navigate(`/insights/people/${id}${rq}`);
  const weekdayName = (d: InsightsWeekday) => t(`insights.weekday.name.${d.weekday}`, { defaultValue: d.name });

  // ---- Key findings ------------------------------------------------------
  const findings = useMemo<Finding[]>(() => {
    if (!data) return [];
    const out: Finding[] = [];
    const h = headline(data);
    const cmp = data.compare ?? null;
    // 1. Attendance vs previous period
    const dAtt = cmp ? deltaOf(h.attendance, cmp.kpis.attendance_pct) : null;
    if (h.presentDays > 0 && dAtt !== null && Math.abs(dAtt) >= 1) {
      out.push({
        id: "att",
        tone: dAtt > 0 ? "good" : "bad",
        text: (
          <Trans
            i18nKey={dAtt > 0 ? `${K}.find.attUp` : `${K}.find.attDown`}
            defaults={
              dAtt > 0
                ? "Attendance was <b>{{pct}}</b>, up {{n}} on {{prev}}."
                : "Attendance was <b>{{pct}}</b>, down {{n}} on {{prev}}."
            }
            values={{
              pct: fmtPct(h.attendance),
              prev: data.period.is_single_day
                ? (cmp?.label ?? "")
                : t(`${K}.find.prevPeriod`, { defaultValue: "the previous {{count}} days", count: data.period.days }),
              n: t(`${K}.find.points`, { defaultValue: "{{count}} points", defaultValue_one: "{{count}} point", count: Math.round(Math.abs(dAtt)) }),
            }}
            components={{ b: <b /> }}
          />
        ),
      });
    }
    // 2. Never seen (enrolment / camera problem)
    const neverSeen = data.watchlist?.totals.never_seen ?? 0;
    if (neverSeen > 0 && !data.period.is_single_day) {
      out.push({
        id: "never",
        tone: "warn",
        text: (
          <Trans
            i18nKey={`${K}.find.neverSeen`}
            defaults="<b>{{count}} of {{total}} employees</b> were never seen by a camera — check their reference photos."
            values={{ count: neverSeen, total: fmtNum(data.scope.employees) }}
            components={{ b: <b /> }}
          />
        ),
        to: "/employees",
        linkLabel: t(`${K}.find.checkPhotos`, { defaultValue: "Employees" }),
      });
    }
    // 3. Weakest weekday
    const wd = (data.weekday ?? []).filter((d) => d.attendance_pct !== null);
    if (wd.length >= 3 && h.presentDays > 0) {
      const weak = wd.reduce((a, c) => ((c.attendance_pct ?? 0) < (a.attendance_pct ?? 0) ? c : a));
      const strong = wd.reduce((a, c) => ((c.attendance_pct ?? 0) > (a.attendance_pct ?? 0) ? c : a));
      if ((strong.attendance_pct ?? 0) - (weak.attendance_pct ?? 0) >= 3) {
        out.push({
          id: "weekday",
          tone: "info",
          text: (
            <Trans
              i18nKey={`${K}.find.weekday`}
              defaults="<b>{{day}}</b> has the lowest attendance ({{pct}}); {{best}} is the strongest ({{bestPct}})."
              values={{ day: weekdayName(weak), pct: fmtPct(weak.attendance_pct), best: weekdayName(strong), bestPct: fmtPct(strong.attendance_pct) }}
              components={{ b: <b /> }}
            />
          ),
        });
      }
    }
    // 4. Frequent latecomers
    const lateN = data.watchlist?.totals.frequent_late ?? 0;
    if (lateN > 0) {
      out.push({
        id: "late",
        tone: "warn",
        text: data.period.is_single_day ? (
          <Trans
            i18nKey={`${K}.find.lateDay`}
            defaults={lateN === 1 ? "<b>{{count}} person</b> arrived after the grace period." : "<b>{{count}} people</b> arrived after the grace period."}
            count={lateN} values={{ count: lateN }}
            components={{ b: <b /> }}
          />
        ) : (
          <Trans
            i18nKey={`${K}.find.late`}
            defaults={lateN === 1 ? "<b>{{count}} person</b> was late on 2 or more days." : "<b>{{count}} people</b> were late on 2 or more days."}
            count={lateN} values={{ count: lateN }}
            components={{ b: <b /> }}
          />
        ),
      });
    }
    // 5. Longest absence streak
    const streak = [...(data.watchlist?.repeated_absent ?? [])].sort((a, c) => c.longest_streak - a.longest_streak)[0];
    if (streak && streak.longest_streak >= 3 && neverSeen < data.scope.employees * 0.5) {
      out.push({
        id: "streak",
        tone: "bad",
        text: (
          <Trans
            i18nKey={`${K}.find.streak`}
            defaults="<b>{{name}}</b> was absent {{count}} working days in a row."
            values={{ name: streak.full_name, count: streak.longest_streak }}
            components={{ b: <b /> }}
          />
        ),
        to: `/insights/people/${streak.employee_id}${rq}`,
      });
    }
    // 6. Department furthest below average
    if (departmentId === null && h.presentDays > 0 && data.departments.length > 1) {
      const rows = data.departments.filter((r) => r.headcount >= 3);
      const worst = rows.reduce<(typeof rows)[number] | null>((a, c) => (!a || c.pct < a.pct ? c : a), null);
      if (worst && h.attendance - worst.pct >= 10) {
        out.push({
          id: "dept",
          tone: "bad",
          text: (
            <Trans
              i18nKey={`${K}.find.deptBelow`}
              defaults="<b>{{name}}</b> is {{n}} below the average ({{pct}} vs {{avg}})."
              values={{
                name: worst.name,
                n: t(`${K}.find.points`, { defaultValue: "{{count}} points", defaultValue_one: "{{count}} point", count: Math.round(h.attendance) - Math.round(worst.pct) }),
                pct: fmtPct(worst.pct),
                avg: fmtPct(h.attendance),
              }}
              components={{ b: <b /> }}
            />
          ),
          to: `/insights/departments/${worst.department_id}${rq}`,
        });
      }
    }
    // 7. Typical arrival vs shift start
    const shiftStart = clockToMinutes(data.shift?.start);
    const avgIn = clockToMinutes(h.avgIn);
    if (shiftStart !== null && avgIn !== null && h.presentDays >= 20) {
      const diff = avgIn - shiftStart;
      out.push({
        id: "arrive",
        tone: diff <= (data.shift?.grace_minutes ?? 0) ? "good" : "warn",
        text: (
          <Trans
            i18nKey={diff <= 0 ? `${K}.find.arriveEarly` : `${K}.find.arriveLate`}
            defaults={
              diff <= 0
                ? "On average people arrive at <b>{{time}}</b>, {{d}} before the {{start}} start."
                : "On average people arrive at <b>{{time}}</b>, {{d}} after the {{start}} start."
            }
            values={{ time: h.avgIn, d: dur(Math.abs(diff)), start: minutesToClock(shiftStart) }}
            components={{ b: <b /> }}
          />
        ),
      });
    }
    // 8. Overtime
    if (data.kpis.ot_hours > 0) {
      out.push({
        id: "ot",
        tone: "neutral",
        text: (
          <Trans
            i18nKey={`${K}.find.overtime`}
            defaults={data.kpis.ot_employees === 1 ? "Overtime totalled <b>{{d}}</b> for {{count}} person." : "Overtime totalled <b>{{d}}</b> across {{count}} people."}
            count={data.kpis.ot_employees} values={{ d: dur(data.kpis.ot_hours * 60), count: data.kpis.ot_employees }}
            components={{ b: <b /> }}
          />
        ),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, departmentId, rq, t, dur]);

  // ---- Header bits -------------------------------------------------------
  const scopeLabel = data?.scope.department_label ?? t("insights.filter.allDepartments", { defaultValue: "All departments" });
  const reportName = `${t(`${K}.pdfName`, { defaultValue: "Attendance report" })} — ${
    data?.period.label ?? (range.start === range.end ? range.start : `${range.start} → ${range.end}`)
  } · ${scopeLabel}`;

  const header = (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t(`${K}.title`, { defaultValue: "Attendance overview" })}</h1>
          <div className="ins-header-meta">
            <span className="ins-period">{data?.period.label ?? " "}</span>
            {data && (
              <>
                <ScopeChip>
                  <Icon name="users" size={12} />
                  {t(`${K}.scopeEmployees`, { defaultValue: "{{count}} employees", count: data.scope.employees })}
                </ScopeChip>
                <ScopeChip>
                  {data.scope.department_label ??
                    t(`${K}.scopeDepartments`, { defaultValue: "{{count}} departments", count: data.scope.departments })}
                </ScopeChip>
                {!data.period.is_single_day && (
                  <ScopeChip>
                    {t(`${K}.scopeWorking`, { defaultValue: "{{count}} working days", defaultValue_one: "{{count}} working day", count: data.period.working_days })}
                  </ScopeChip>
                )}
              </>
            )}
          </div>
        </div>
        <div className="page-actions">
          <DownloadPdfButton range={range} departmentId={departmentId} reportName={reportName} />
        </div>
      </div>
      <div className="ins-toolbar">
        <RangePicker range={range} preset={preset} onChange={setRange} />
        <FilterSelect
          label={t("insights.filter.department", { defaultValue: "Department" })}
          value={departmentId !== null ? String(departmentId) : ""}
          onChange={setDepartment}
          options={deptOptions}
        />
        {q.isFetching && data && (
          <span className="ins-fetching" role="status">
            <Icon name="refresh" size={12} />
            {t("insights.updating", { defaultValue: "Updating…" })}
          </span>
        )}
      </div>
    </>
  );

  if (q.isError && !data) {
    return (
      <>
        {header}
        <InsightsError error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  if (!data) {
    return (
      <>
        {header}
        <HeadlineSkeleton />
        <div className="ins-row ins-row-3-2">
          <Panel title={t(`${K}.q.trend`, { defaultValue: "Is attendance holding up?" })}>
            <ChartSkeleton height={230} />
          </Panel>
          <Panel title={t(`${K}.q.weekday`, { defaultValue: "Which day of the week is weakest?" })}>
            <ChartSkeleton height={230} />
          </Panel>
        </div>
      </>
    );
  }
  if (data.kpis.total === 0) {
    return (
      <>
        {header}
        <div className="card ins-page-state">
          <PanelEmpty
            icon="users"
            title={t("insights.empty.noEmployees", { defaultValue: "No employees in scope" })}
            body={t("insights.empty.noEmployeesBody", {
              defaultValue: "There are no active employees for this period and filter. Try another range or department.",
            })}
          />
        </div>
      </>
    );
  }

  // ---- Headline metrics ---------------------------------------------------
  const h = headline(data);
  const cmp = data.compare ?? null;
  const single = data.period.is_single_day;
  const vsPrev = cmp
    ? single
      ? t(`${K}.vsPrevDay`, { defaultValue: "vs {{label}}", label: cmp.label })
      : t(`${K}.vsPrev`, { defaultValue: "vs previous {{days}} days", days: data.period.days })
    : "";
  const cmpTitle = cmp ? t(`${K}.cmpTitle`, { defaultValue: "Compared with {{label}}", label: cmp.label }) : undefined;
  const comp = (delta: number | null, unit: HeadlineComparison["unit"], better: HeadlineComparison["better"]): HeadlineComparison[] =>
    cmp ? [{ vs: vsPrev, delta, unit, better, ...(cmpTitle ? { title: cmpTitle } : {}) }] : [];
  const shiftStart = clockToMinutes(data.shift?.start);
  const avgInMin = clockToMinutes(h.avgIn);
  // Rates built on a handful of arrivals swing wildly — don't compare them.
  const MIN_SAMPLE = 20;
  const enoughNow = h.presentDays >= MIN_SAMPLE;
  const enoughPrev = (cmp?.kpis.present_days ?? 0) >= MIN_SAMPLE;
  const arrivalCmpOk = enoughNow && enoughPrev;
  const absentPctOfExpected = h.expected > 0 ? (data.kpis.absent / h.expected) * 100 : null;

  // Sparse: most of the workforce never appeared on camera.
  const neverSeen = data.watchlist?.totals.never_seen ?? 0;
  const sparse = !single && data.scope.employees > 0 && neverSeen / data.scope.employees >= 0.5;
  const sparseSingle = single && h.attendance < 10 && data.kpis.absent > data.scope.employees * 0.5;

  const trendDays = chartSrc?.trend;
  const peak = data.arrivals.reduce<(typeof data.arrivals)[number] | null>((p, b) => (!p || b.count > p.count ? b : p), null);
  const weekday = chartSrc?.weekday ?? [];

  return (
    <>
      {header}

      {(sparse || sparseSingle) && (
        <InsightsNotice
          tone="info"
          icon="camera"
          title={t(`${K}.sparse.title`, { defaultValue: "Most employees have no camera sightings in this period" })}
          body={
            sparse
              ? t(`${K}.sparse.body`, {
                  defaultValue:
                    "{{count}} of {{total}} people were never seen, so attendance looks lower than it really is. Check that each person has a clear reference photo and that the entrance cameras are online.",
                  count: neverSeen,
                  total: fmtNum(data.scope.employees),
                })
              : t(`${K}.sparse.bodyDay`, {
                  defaultValue:
                    "Very few people were recognised today. Check that each person has a clear reference photo and that the entrance cameras are online.",
                })
          }
          action={
            <>
              <Link className="btn btn-sm" to="/employees">
                {t(`${K}.sparse.photos`, { defaultValue: "Employee photos" })}
              </Link>
              <Link className="btn btn-sm" to="/cameras">
                {t(`${K}.sparse.cameras`, { defaultValue: "Cameras" })}
              </Link>
            </>
          }
        />
      )}

      <HeadlineRow>
        <HeadlineMetric
          label={t(`${K}.hl.attendance`, { defaultValue: "Attendance" })}
          value={fmtNum(Math.round(h.attendance))}
          suffix="%"
          meter={{ pct: h.attendance, tone: "accent", marker: cmp?.kpis.attendance_pct ?? null, markerLabel: cmpTitle ?? "" }}
          context={
            single
              ? t(`${K}.hl.attendanceCtxDay`, {
                  defaultValue: "{{n}} of {{total}} employees came in",
                  n: fmtNum(h.presentDays),
                  total: fmtNum(data.kpis.total),
                })
              : t(`${K}.hl.attendanceCtx`, {
                  defaultValue: "{{n}} of {{total}} expected working days",
                  n: fmtNum(h.presentDays),
                  total: fmtNum(h.expected),
                })
          }
          comparisons={comp(cmp ? deltaOf(Math.round(h.attendance), cmp.kpis.attendance_pct !== null ? Math.round(cmp.kpis.attendance_pct) : null) : null, "pts", "up")}
          title={t(`${K}.hl.attendanceTitle`, { defaultValue: "Days people were present ÷ working days expected (employees × working days)" })}
        />
        <HeadlineMetric
          label={t(`${K}.hl.onTime`, { defaultValue: "On time" })}
          value={h.punctuality !== null ? fmtNum(Math.round(h.punctuality)) : "—"}
          {...(h.punctuality !== null ? { suffix: "%" } : {})}
          meter={{ pct: h.punctuality, tone: "success", marker: cmp?.kpis.punctuality_pct ?? null, markerLabel: cmpTitle ?? "" }}
          context={
            h.presentDays === 0
              ? t(`${K}.hl.onTimeNone`, { defaultValue: "No arrivals recorded yet" })
              : data.kpis.late === 0
                ? t(`${K}.hl.onTimeAll`, { defaultValue: "Nobody arrived after the grace period" })
                : data.kpis.avg_late_minutes !== null
                  ? t(`${K}.hl.onTimeCtx`, {
                      defaultValue: "{{count}} late arrivals · avg {{d}} late",
                      defaultValue_one: "{{count}} late arrival · avg {{d}} late",
                      count: data.kpis.late,
                      d: dur(data.kpis.avg_late_minutes),
                    })
                  : t(`${K}.hl.onTimeCtxNoAvg`, { defaultValue: "{{count}} late arrivals", defaultValue_one: "{{count}} late arrival", count: data.kpis.late })
          }
          comparisons={comp(
            cmp && arrivalCmpOk && h.punctuality !== null && cmp.kpis.punctuality_pct !== null ? Math.round(h.punctuality) - Math.round(cmp.kpis.punctuality_pct) : null,
            "pts",
            "up",
          )}
          title={t(`${K}.hl.onTimeTitle`, { defaultValue: "Present days that started within the shift's grace period" })}
        />
        <HeadlineMetric
          label={t(`${K}.hl.arrival`, { defaultValue: "Typical arrival" })}
          value={h.avgIn ?? "—"}
          context={
            shiftStart !== null && avgInMin !== null
              ? avgInMin - shiftStart === 0
                ? t(`${K}.hl.arrivalOnStart`, { defaultValue: "Right at the {{start}} shift start", start: minutesToClock(shiftStart) })
                : avgInMin < shiftStart
                  ? t(`${K}.hl.arrivalBefore`, { defaultValue: "{{d}} before the {{start}} start", d: dur(shiftStart - avgInMin), start: minutesToClock(shiftStart) })
                  : t(`${K}.hl.arrivalAfter`, { defaultValue: "{{d}} after the {{start}} start", d: dur(avgInMin - shiftStart), start: minutesToClock(shiftStart) })
              : data.shift
                ? t(`${K}.hl.arrivalShift`, { defaultValue: "Shift starts {{start}}", start: data.shift.start })
                : t(`${K}.hl.arrivalCtx`, { defaultValue: "Average first check-in" })
          }
          comparisons={comp(cmp && arrivalCmpOk ? clockDelta(h.avgIn, cmp.kpis.avg_in) : null, "clock", "down")}
          title={t(`${K}.hl.arrivalTitle`, { defaultValue: "Mean first check-in time over present days" })}
        />
        <HeadlineMetric
          label={t(`${K}.hl.absences`, { defaultValue: "Absences" })}
          value={fmtNum(data.kpis.absent)}
          context={
            single
              ? t(`${K}.hl.absencesCtxDay`, {
                  defaultValue: "people absent without leave · {{leave}} on leave",
                  leave: fmtNum(data.kpis.leave),
                })
              : t(`${K}.hl.absencesCtx`, {
                  defaultValue: "{{pct}} of expected days · {{leave}} on approved leave",
                  pct: fmtPct(absentPctOfExpected),
                  leave: fmtNum(data.kpis.leave),
                })
          }
          comparisons={comp(cmp ? deltaOf(data.kpis.absent, cmp.kpis.absent) : null, "count", "down")}
          title={t(`${K}.hl.absencesTitle`, { defaultValue: "Working days with no detection and no approved leave" })}
        />
      </HeadlineRow>

      <KeyFindings
        items={findings}
        {...(cmp ? { sub: t(`${K}.find.sub`, { defaultValue: "Compared with {{label}}", label: cmp.label }) } : {})}
        emptyText={t(`${K}.find.empty`, { defaultValue: "Nothing unusual stands out in this period." })}
      />

      <div className="ins-row ins-row-3-2">
        <Panel
          title={
            <QuestionTitle
              question={t(`${K}.q.trend`, { defaultValue: "Is attendance holding up?" })}
              answer={
                single
                  ? t(`${K}.q.trendSubDay`, { defaultValue: "Attendance on each working day of the last {{count}} days", count: CONTEXT_DAYS })
                  : t(`${K}.q.trendSub`, { defaultValue: "Share of employees present on each working day" })
              }
            />
          }
        >
          {trendDays ? (
            <AttendanceTrendChart
              days={trendDays}
              reference={!single ? (cmp?.kpis.attendance_pct ?? null) : null}
              referenceLabel={t(`${K}.prevAvg`, { defaultValue: "Previous period" })}
              {...(single ? { highlightDate: range.end } : {})}
            />
          ) : (
            <ChartSkeleton height={230} />
          )}
        </Panel>
        <Panel
          title={
            <QuestionTitle
              question={t(`${K}.q.weekday`, { defaultValue: "Which day of the week is weakest?" })}
              answer={t(`${K}.q.weekdaySub`, { defaultValue: "Average attendance per weekday" })}
            />
          }
        >
          {chartSrc ? (
            <WeekdayChart days={weekday} reference={headline(chartSrc).attendance} referenceLabel={t(`${K}.periodAvg`, { defaultValue: "Period average" })} />
          ) : (
            <ChartSkeleton height={200} />
          )}
        </Panel>
      </div>

      <div className="ins-row ins-row-1-1">
        <Panel
          title={
            <QuestionTitle
              question={t(`${K}.q.arrivals`, { defaultValue: "Are people arriving on time?" })}
              answer={
                data.shift
                  ? t(`${K}.q.arrivalsSub`, {
                      defaultValue: "First check-in times · {{name}}, {{grace}} min grace",
                      name: data.shift.name,
                      grace: data.shift.grace_minutes,
                    })
                  : t(`${K}.q.arrivalsSubNoShift`, { defaultValue: "First check-in times, 30-minute slots" })
              }
            />
          }
        >
          <ArrivalChart buckets={data.arrivals} shift={data.shift ?? null} height={250} />
          {h.presentDays > 0 && (
            <MiniStats
              items={[
                {
                  label: t(`${K}.arr.onTime`, { defaultValue: "On time" }),
                  value: fmtNum(Math.max(0, h.presentDays - data.kpis.late)),
                  sub: t(`${K}.arr.ofArrivals`, { defaultValue: "{{pct}} of arrivals", pct: fmtPct(h.punctuality) }),
                  tone: "success",
                },
                {
                  label: t(`${K}.arr.late`, { defaultValue: "After grace" }),
                  value: fmtNum(data.kpis.late),
                  sub:
                    data.kpis.avg_late_minutes !== null
                      ? t(`${K}.arr.avgLate`, { defaultValue: "avg {{d}} late", d: dur(data.kpis.avg_late_minutes) })
                      : "—",
                  tone: data.kpis.late > 0 ? "warning" : "neutral",
                },
                {
                  label: t(`${K}.arr.busiest`, { defaultValue: "Busiest half-hour" }),
                  value: peak ? `${peak.bucket}` : "—",
                  sub: peak ? t(`${K}.arr.peakCount`, { defaultValue: "{{count}} arrivals", defaultValue_one: "{{count}} arrival", count: peak.count }) : "",
                },
              ]}
            />
          )}
        </Panel>
        {data.watchlist ? (
          <WatchlistPanel
            watchlist={data.watchlist}
            range={range}
            single={single}
            hideDepartment={departmentId !== null}
            {...(sparse ? { initial: "never_seen" as const } : {})}
          />
        ) : (
          <Panel title={t("insights.watch.title", { defaultValue: "Who needs a follow-up?" })}>
            <ChartSkeleton height={200} />
          </Panel>
        )}
      </div>

      {departmentId === null && (
        <div className="ins-section">
          <Panel
            title={
              <QuestionTitle
                question={t(`${K}.q.depts`, { defaultValue: "How do departments compare?" })}
                answer={t(`${K}.q.deptsSub`, {
                  defaultValue: "Lowest attendance first · {{count}} departments · average {{avg}}",
                  count: data.departments.length,
                  avg: fmtPct(h.attendance),
                })}
              />
            }
            actions={
              <Link className="btn btn-sm" to={`/insights/departments${rq}`}>
                {t(`${K}.allDepts`, { defaultValue: "All department insights" })}
              </Link>
            }
            bodyPadding={0}
          >
            <DepartmentCompareTable rows={data.departments} range={range} average={h.attendance} />
          </Panel>
        </div>
      )}

      <div className="ins-section">
        <Panel
          title={
            <QuestionTitle
              question={t(`${K}.q.exceptions`, { defaultValue: "Day-by-day exceptions" })}
              answer={t(`${K}.q.exceptionsSub`, {
                defaultValue: "Every absence, late arrival, early exit and short day · {{count}} records",
                count: data.exceptions_total,
              })}
            />
          }
          bodyPadding={0}
          actions={
            excStatuses.length > 1 ? (
              <div className="seg ins-filter-chips" role="group" aria-label={t("insights.exc.filter", { defaultValue: "Filter by status" })}>
                <button type="button" className={`seg-btn${excStatus === "" ? " active" : ""}`} aria-pressed={excStatus === ""} onClick={() => setExcStatus("")}>
                  {t("insights.exc.all", { defaultValue: "All" })} · {fmtNum(exceptions.length)}
                </button>
                {excStatuses.map(([s, n]) => (
                  <button key={s} type="button" className={`seg-btn${excStatus === s ? " active" : ""}`} aria-pressed={excStatus === s} onClick={() => setExcStatus(s)}>
                    {statusLabel(s)} · {fmtNum(n)}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        >
          <ExceptionsTable
            rows={filteredExceptions}
            total={excStatus ? filteredExceptions.length : data.exceptions_total}
            showDate={!single}
            page={page}
            onPageChange={setPage}
            onOpenPerson={openPerson}
            pageSize={10}
          />
        </Panel>
      </div>
    </>
  );
}
