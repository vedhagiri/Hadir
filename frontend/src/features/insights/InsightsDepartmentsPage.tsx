// MaugoodAI Insights — Department-wise dashboard (v2).
//
//   /insights/departments                 → compare departments: 4 headline
//                                            metrics, key findings, a compact
//                                            sortable table and a
//                                            department × working-day heatmap
//   /insights/departments/:departmentId   → one department in depth: metrics
//                                            vs previous period and vs the
//                                            company, findings, weekday
//                                            pattern, arrival times, team
//                                            roster with a status strip,
//                                            watchlists, exceptions
//
// Every figure comes from /api/insights/* which reuses the attendance PDF
// context builders (reporting/pdf.py), so the numbers match the PDF. The
// range lives in the URL (?start=&end=) so links are shareable and survive
// the department switcher and the drill-down to a person.
//
// The v2 fields (compare / weekday / shift / watchlist / heatmap / company /
// strip …) are optional on the wire types: when an older backend omits
// them, the page derives what it can from the v1 fields and hides the rest.

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api } from "../../api/client";
import { todayIso } from "../../components/DatePicker";
import { FilterSelect, SearchField } from "../../components/ListPageUi";
import { SkeletonLines, SkeletonRows } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { useInsightsDepartment, useInsightsOverview } from "./hooks";
import type { InsightsRange } from "./hooks";
import {
  ArrivalChart,
  AttentionChips,
  ChartSkeleton,
  DeltaBadge,
  DeptDayHeatmap,
  DownloadPdfButton,
  ExceptionsTable,
  HeadlineMetric,
  HeadlineRow,
  HeadlineSkeleton,
  InsightsError,
  InsightsNotice,
  KeyFindings,
  Panel,
  PanelEmpty,
  PersonAvatar,
  QuestionTitle,
  RangePicker,
  ScopeChip,
  WatchlistPanel,
  WeekdayChart,
  addDays,
  clock,
  clockDelta,
  clockToMinutes,
  daysBetween,
  deltaOf,
  fmtNum,
  fmtPct,
  parseIsoDate,
  pctOf,
  rangeQuery,
  useDateFmt,
  useDurationFmt,
  useInsightsRange,
  useStatusLabel,
} from "./insightsUi";
import type { Finding, HeadlineComparison } from "./insightsUi";
import type {
  InsightsBenchmark,
  InsightsCompare,
  InsightsDepartment,
  InsightsDepartmentEmployee,
  InsightsKpis,
  InsightsOverview,
  InsightsPeriod,
  InsightsShift,
  InsightsStatus,
  InsightsTrendDay,
  InsightsWatchlist,
  InsightsWeekday,
} from "./types";

import "./insights-departments.css";

const K = "insights.departments";

// ---------------------------------------------------------------------------
// Small pure helpers (v1 fallbacks for the v2 figures)
// ---------------------------------------------------------------------------

function attendanceOf(k: InsightsKpis): number {
  return k.attendance_pct ?? k.present_pct;
}

function punctualityOf(k: InsightsKpis): number | null {
  if (k.punctuality_pct !== undefined) return k.punctuality_pct;
  return pctOf(k.present - k.late, k.present);
}

function presentDaysOf(k: InsightsKpis): number {
  return k.present_days ?? k.present;
}

function expectedDaysOf(k: InsightsKpis, period: InsightsPeriod): number {
  return k.expected_days ?? k.total * Math.max(1, period.working_days);
}

/** The same number of calendar days immediately before ``range.start``. */
function previousRange(range: InsightsRange): InsightsRange {
  const len = daysBetween(range.start, range.end) + 1;
  return { start: addDays(range.start, -len), end: addDays(range.start, -1) };
}

/** Mon=0 … Sun=6 → localised weekday name. */
function weekdayName(idx: number, lang: string, style: "long" | "short" = "long"): string {
  const d = new Date(2024, 0, 1 + idx); // 1 Jan 2024 was a Monday
  return d.toLocaleDateString(lang.startsWith("ar") ? "ar" : "en-GB", { weekday: style });
}

/** "Repeatedly" threshold — scaled down for short ranges. */
function attentionThreshold(workingDays: number): number {
  if (workingDays >= 5) return 3;
  if (workingDays >= 2) return 2;
  return 1;
}

function compareFromKpis(k: InsightsKpis, period: InsightsPeriod): InsightsCompare {
  return {
    label: period.label,
    kpis: {
      attendance_pct: attendanceOf(k),
      punctuality_pct: punctualityOf(k),
      avg_in: k.avg_in ?? null,
      avg_hours: k.avg_hours,
      late: k.late,
      absent: k.absent,
      leave: k.leave,
      ot_hours: k.ot_hours,
      present_days: presentDaysOf(k),
      expected_days: expectedDaysOf(k, period),
    },
  };
}

function weekdayFromTrend(trend: InsightsTrendDay[], lang: string): InsightsWeekday[] {
  const acc = new Map<number, { days: number; present: number; head: number; late: number; absent: number }>();
  for (const d of trend) {
    if (d.is_weekend || d.is_holiday) continue;
    const dt = parseIsoDate(d.date);
    if (!dt || d.headcount <= 0 || d.present + d.absent + d.leave + d.late === 0) continue;
    const wd = (dt.getDay() + 6) % 7;
    const a = acc.get(wd) ?? { days: 0, present: 0, head: 0, late: 0, absent: 0 };
    a.days += 1;
    a.present += d.present;
    a.head += d.headcount;
    a.late += d.late;
    a.absent += d.absent;
    acc.set(wd, a);
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wd, a]) => ({
      weekday: wd,
      name: weekdayName(wd, lang, "short"),
      working_days: a.days,
      attendance_pct: pctOf(a.present, a.head),
      punctuality_pct: null,
      late: a.late,
      absent: a.absent,
    }));
}

/** Work-week order (start after the longest weekday gap, e.g. Sun … Thu
 *  for a Fri/Sat weekend) — the order the shared WeekdayChart draws in. */
function workWeekOrder(rows: InsightsWeekday[]): InsightsWeekday[] {
  const s = [...rows].sort((a, b) => a.weekday - b.weekday);
  if (s.length < 2) return s;
  let cut = 0;
  let best = -1;
  for (let i = 0; i < s.length; i++) {
    const gap = (s[i]!.weekday - s[(i - 1 + s.length) % s.length]!.weekday + 7) % 7;
    if (gap > best) {
      best = gap;
      cut = i;
    }
  }
  return [...s.slice(cut), ...s.slice(0, cut)];
}

function weakestWeekday(rows: InsightsWeekday[], minGap = 5): InsightsWeekday | null {
  const valid = workWeekOrder(rows).filter((w) => w.attendance_pct !== null && w.working_days > 0);
  if (valid.length < 2) return null;
  const lo = valid.reduce((a, b) => ((b.attendance_pct ?? 0) < (a.attendance_pct ?? 0) ? b : a));
  const hi = valid.reduce((a, b) => ((b.attendance_pct ?? 0) > (a.attendance_pct ?? 0) ? b : a));
  // Only worth saying when the weakest day stands out.
  return (hi.attendance_pct ?? 0) - (lo.attendance_pct ?? 0) >= minGap ? lo : null;
}

// ---------------------------------------------------------------------------
// Local queries (previous-period fallbacks for older backends)
// ---------------------------------------------------------------------------

function useDepartmentAt(departmentId: number, range: InsightsRange, enabled: boolean) {
  return useQuery({
    queryKey: ["insights", "department", departmentId, range.start, range.end],
    queryFn: () => api<InsightsDepartment>(`/api/insights/departments/${departmentId}?start=${range.start}&end=${range.end}`),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Local atoms
// ---------------------------------------------------------------------------

/** Attendance bar: neutral track, accent fill, optional company tick. */
function AttendanceBar({ pct, reference }: { pct: number | null; reference?: number | null }) {
  const p = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <span className="ind-attbar">
      <span className="ind-attbar-track" aria-hidden>
        <span className="ind-attbar-fill" style={{ inlineSize: `${p}%` }} />
        {reference !== null && reference !== undefined && (
          <span className="ind-attbar-ref" style={{ insetInlineStart: `${Math.max(0, Math.min(100, reference))}%` }} />
        )}
      </span>
      <span className="ind-attbar-val">{fmtPct(pct)}</span>
    </span>
  );
}

function SortTh({
  label,
  active,
  asc,
  onClick,
  end = true,
  className,
}: {
  label: string;
  active: boolean;
  asc: boolean;
  onClick: () => void;
  end?: boolean;
  className?: string;
}) {
  const cls = [end ? "ins-end" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <th className={cls || undefined} aria-sort={active ? (asc ? "ascending" : "descending") : "none"}>
      <button type="button" className="ind-sort" data-active={active} onClick={onClick}>
        {label}
        <span className="ind-sort-ic" aria-hidden>
          <Icon name={active ? (asc ? "chevronUp" : "chevronDown") : "chevronsUpDown"} size={11} />
        </span>
      </button>
    </th>
  );
}

function Toolbar({ fetching, children }: { fetching: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="ins-toolbar">
      {children}
      {fetching && (
        <span className="ins-fetching" role="status">
          <Icon name="refresh" size={12} />
          {t("insights.updating", { defaultValue: "Updating…" })}
        </span>
      )}
    </div>
  );
}

function SparseNotice({ single = false, isToday = false }: { single?: boolean; isToday?: boolean }) {
  const { t } = useTranslation();
  return (
    <InsightsNotice
      icon="camera"
      title={
        single
          ? isToday
            ? t(`${K}.sparse.titleToday`, { defaultValue: "Nobody has been seen by a camera today yet" })
            : t(`${K}.sparse.titleDay`, { defaultValue: "Nobody was seen by a camera on this day" })
          : t(`${K}.sparse.title`, { defaultValue: "Most employees have no camera sightings in this period" })
      }
      body={
        <>
          {t(`${K}.sparse.body`, {
            defaultValue:
              "That usually points to missing reference photos or cameras that don't cover the entrances, rather than real absence. Check photos and camera coverage before acting on these figures.",
          })}{" "}
          <Link className="ind-flink" to="/employees">
            {t(`${K}.sparse.photos`, { defaultValue: "Employee photos" })}
          </Link>
          {" · "}
          <Link className="ind-flink" to="/cameras">
            {t(`${K}.sparse.cameras`, { defaultValue: "Cameras" })}
          </Link>
        </>
      }
    />
  );
}

function NameLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="ind-flink" to={to}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Headline metrics (shared by both views)
// ---------------------------------------------------------------------------

function DeptHeadline({
  kpis,
  period,
  compare,
  shift,
  company,
  lateDepts,
  deptCount,
}: {
  kpis: InsightsKpis;
  period: InsightsPeriod;
  compare: InsightsCompare | null;
  shift: InsightsShift | null;
  /** Detail view only: company benchmark → "vs company" + hours tile. */
  company?: InsightsBenchmark | null;
  lateDepts?: number;
  deptCount?: number;
}) {
  const { t } = useTranslation();
  const dur = useDurationFmt();
  const single = period.is_single_day;
  const att = attendanceOf(kpis);
  const punct = punctualityOf(kpis);
  const present = presentDaysOf(kpis);
  const expected = expectedDaysOf(kpis, period);
  const onTime = Math.max(0, present - kpis.late);
  const avgIn = kpis.avg_in ?? null;
  const c = compare?.kpis;
  const vsPrev = single
    ? t(`${K}.m.vsPrevDay`, { defaultValue: "vs previous day" })
    : t(`${K}.m.vsPrev`, { defaultValue: "vs previous period" });
  const vsCompany = t(`${K}.m.vsCompany`, { defaultValue: "vs company" });
  const detail = company !== undefined;
  const cmp = (prev: HeadlineComparison | null, comp: HeadlineComparison | null): HeadlineComparison[] =>
    [prev, comp].filter((x): x is HeadlineComparison => x !== null);
  const prevTitle = (v: string) => (compare ? `${compare.label}: ${v}` : undefined);
  const withTitle = (h: Omit<HeadlineComparison, "title">, title: string | undefined): HeadlineComparison => (title ? { ...h, title } : h);

  const startMin = clockToMinutes(shift?.start);
  const avgMin = clockToMinutes(avgIn);
  const vsShift = startMin !== null && avgMin !== null ? avgMin - startMin : null;

  return (
    <HeadlineRow>
      <HeadlineMetric
        label={t(`${K}.m.attendance`, { defaultValue: "Attendance" })}
        value={fmtPct(att)}
        meter={{ pct: att, marker: detail ? (company?.attendance_pct ?? null) : null, markerLabel: vsCompany }}
        context={
          single
            ? t(`${K}.m.attSubDay`, { defaultValue: "{{present}} of {{expected}} people came in", present: fmtNum(present), expected: fmtNum(expected) })
            : t(`${K}.m.attSub`, { defaultValue: "{{present}} of {{expected}} expected working days", present: fmtNum(present), expected: fmtNum(expected) })
        }
        comparisons={cmp(
          c ? withTitle({ vs: vsPrev, delta: deltaOf(att, c.attendance_pct), unit: "pts", better: "up" }, prevTitle(fmtPct(c.attendance_pct))) : null,
          detail && company
            ? withTitle({ vs: vsCompany, delta: deltaOf(att, company.attendance_pct), unit: "pts", better: "up" }, `${vsCompany}: ${fmtPct(company.attendance_pct)}`)
            : null,
        )}
      />
      <HeadlineMetric
        label={t(`${K}.m.punctuality`, { defaultValue: "On time" })}
        value={fmtPct(punct)}
        context={
          present > 0
            ? t(`${K}.m.punctSub`, { defaultValue: "{{onTime}} of {{present}} arrivals were on time", onTime: fmtNum(onTime), present: fmtNum(present) })
            : t(`${K}.m.punctNone`, { defaultValue: "Nobody was seen arriving" })
        }
        comparisons={cmp(
          c ? withTitle({ vs: vsPrev, delta: deltaOf(punct, c.punctuality_pct), unit: "pts", better: "up" }, prevTitle(fmtPct(c.punctuality_pct))) : null,
          detail && company
            ? withTitle({ vs: vsCompany, delta: deltaOf(punct, company.punctuality_pct), unit: "pts", better: "up" }, `${vsCompany}: ${fmtPct(company.punctuality_pct)}`)
            : null,
        )}
      />
      <HeadlineMetric
        label={t(`${K}.m.avgIn`, { defaultValue: "Average arrival" })}
        value={clock(avgIn)}
        context={
          vsShift !== null && shift
            ? vsShift <= 0
              ? t(`${K}.m.avgInEarly`, { defaultValue: "{{d}} before the {{start}} start", d: dur(Math.abs(vsShift)), start: shift.start })
              : t(`${K}.m.avgInLate`, { defaultValue: "{{d}} after the {{start}} start", d: dur(vsShift), start: shift.start })
            : avgIn
              ? t(`${K}.m.avgInSub`, { defaultValue: "mean first check-in on present days" })
              : t(`${K}.m.noArrivals`, { defaultValue: "No arrivals recorded" })
        }
        comparisons={cmp(
          c && avgIn ? withTitle({ vs: vsPrev, delta: clockDelta(avgIn, c.avg_in), unit: "clock", better: "down" }, prevTitle(clock(c.avg_in))) : null,
          detail && company && avgIn
            ? withTitle({ vs: vsCompany, delta: clockDelta(avgIn, company.avg_in), unit: "clock", better: "down" }, `${vsCompany}: ${clock(company.avg_in)}`)
            : null,
        )}
      />
      {detail ? (
        <HeadlineMetric
          label={t(`${K}.m.avgHours`, { defaultValue: "Hours per day" })}
          value={kpis.avg_hours === null ? "—" : dur(kpis.avg_hours * 60)}
          context={
            kpis.ot_hours > 0
              ? t(`${K}.m.hoursSubOt`, { defaultValue: "average on present days · {{ot}} overtime in total", ot: dur(kpis.ot_hours * 60) })
              : t(`${K}.m.hoursSub`, { defaultValue: "average on present days" })
          }
          comparisons={cmp(
            c && kpis.avg_hours !== null
              ? withTitle({ vs: vsPrev, delta: deltaOf(kpis.avg_hours, c.avg_hours), unit: "hours", better: "up" }, prevTitle(c.avg_hours === null ? "—" : dur(c.avg_hours * 60)))
              : null,
            company && kpis.avg_hours !== null
              ? withTitle(
                  { vs: vsCompany, delta: deltaOf(kpis.avg_hours, company.avg_hours), unit: "hours", better: "up" },
                  `${vsCompany}: ${company.avg_hours === null ? "—" : dur(company.avg_hours * 60)}`,
                )
              : null,
          )}
        />
      ) : (
        <HeadlineMetric
          label={t(`${K}.m.late`, { defaultValue: "Late arrivals" })}
          value={fmtNum(kpis.late)}
          context={
            kpis.late > 0
              ? t(`${K}.m.lateSub`, {
                  defaultValue: "in {{d}} of {{n}} departments · avg {{min}} late",
                  d: fmtNum(lateDepts ?? 0),
                  n: fmtNum(deptCount ?? 0),
                  min: dur(kpis.avg_late_minutes),
                })
              : t(`${K}.m.lateNone`, { defaultValue: "Nobody arrived after the grace period" })
          }
          comparisons={cmp(c ? withTitle({ vs: vsPrev, delta: kpis.late - c.late, unit: "count", better: "down" }, prevTitle(fmtNum(c.late))) : null, null)}
        />
      )}
    </HeadlineRow>
  );
}

// ---------------------------------------------------------------------------
// Page entry
// ---------------------------------------------------------------------------

export function InsightsDepartmentsPage() {
  const { departmentId } = useParams();
  const id = departmentId && /^\d+$/.test(departmentId) ? Number(departmentId) : null;
  return id === null ? <DepartmentListView /> : <DepartmentDetailView key={id} departmentId={id} />;
}

// ===========================================================================
// LIST VIEW
// ===========================================================================

interface DeptCalc {
  id: number;
  name: string;
  headcount: number;
  att: number;
  punct: number | null;
  late: number;
  absent: number;
  present: number;
  avgIn: string | null;
  otHours: number;
  prevAtt: number | null;
  delta: number | null;
}

type ListSort = "name" | "att" | "delta" | "punct" | "late" | "absent" | "avgIn" | "ot";

function DepartmentListView() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const dur = useDurationFmt();
  const { range, preset, setRange } = useInsightsRange();
  const q = useInsightsOverview(range, null);
  const data = q.data;
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ListSort>("att");
  const [asc, setAsc] = useState(false);

  const single = data?.period.is_single_day ?? range.start === range.end;
  const deptHref = (id: number) => `/insights/departments/${id}${rangeQuery(range)}`;
  const open = (id: number) => navigate(deptHref(id));

  const rows = useMemo<DeptCalc[]>(() => {
    if (!data) return [];
    return data.departments.map((d) => {
      const att = d.attendance_pct ?? d.pct;
      const prevAtt = d.prev_attendance_pct ?? null;
      return {
        id: d.department_id,
        name: d.name,
        headcount: d.headcount,
        att,
        punct: d.punctuality_pct ?? null,
        late: d.late,
        absent: d.absent,
        present: d.present,
        avgIn: d.avg_in ?? null,
        otHours: d.ot_hours,
        prevAtt,
        delta: deltaOf(att, prevAtt),
      };
    });
  }, [data]);

  const compare: InsightsCompare | null = data?.compare ?? null;

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : [...rows];
    const val = (r: DeptCalc): number | string => {
      switch (sort) {
        case "name": return r.name.toLowerCase();
        case "att": return r.att;
        case "delta": return r.delta ?? (asc ? Number.MAX_VALUE : -Number.MAX_VALUE);
        case "punct": return r.punct ?? (asc ? Number.MAX_VALUE : -1);
        case "late": return r.late;
        case "absent": return r.absent;
        case "avgIn": return clockToMinutes(r.avgIn) ?? (asc ? Number.MAX_VALUE : -1);
        case "ot": return r.otHours;
      }
    };
    list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return (asc ? c : -c) || b.headcount - a.headcount || a.name.localeCompare(b.name);
    });
    return list;
  }, [rows, search, sort, asc]);

  const setSortKey = (k: ListSort) => {
    if (k === sort) setAsc((a) => !a);
    else {
      setSort(k);
      setAsc(k === "name" || k === "avgIn");
    }
  };

  const companyAtt = data ? attendanceOf(data.kpis) : null;
  const weekdays = useMemo(
    () => (data ? (data.weekday && data.weekday.length ? data.weekday : weekdayFromTrend(data.trend, i18n.language)) : []),
    [data, i18n.language],
  );
  const findings = useMemo(
    () => (data ? listFindings(data, rows, companyAtt ?? 0, weekdays, t, i18n.language, deptHref) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, rows, companyAtt, weekdays, t, i18n.language],
  );
  const sparse = !!data && rows.length > 0 && (single ? data.kpis.present === 0 : (companyAtt ?? 0) < 25);

  // Heatmap rows follow the table's order so the two read together.
  const heatmap = useMemo(() => {
    if (!data?.heatmap) return null;
    const rank = new Map(shown.map((r, i) => [r.id, i]));
    const rowsSorted = data.heatmap.rows
      .filter((r) => rank.has(r.department_id))
      .sort((a, b) => (rank.get(a.department_id) ?? 0) - (rank.get(b.department_id) ?? 0));
    return { ...data.heatmap, rows: rowsSorted };
  }, [data, shown]);

  const reportName = `${t(`${K}.pdfNameAll`, { defaultValue: "Attendance report — all departments" })} · ${data?.period.label ?? ""}`;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t(`${K}.title`, { defaultValue: "Department insights" })}</h1>
          <div className="ins-header-meta">
            <span className="ins-period">{data?.period.label ?? " "}</span>
            {data && (
              <>
                <ScopeChip>{t(`${K}.scope.departments`, { defaultValue: "Departments: {{n}}", n: fmtNum(rows.length) })}</ScopeChip>
                <ScopeChip>
                  <Icon name="users" size={12} />
                  {t(`${K}.scope.employees`, { defaultValue: "Employees: {{n}}", n: fmtNum(data.scope.employees) })}
                </ScopeChip>
              </>
            )}
          </div>
        </div>
        <div className="ind-header-actions">
          <DownloadPdfButton range={range} reportName={reportName} />
        </div>
      </div>

      <Toolbar fetching={q.isFetching && !!data}>
        <RangePicker range={range} preset={preset} onChange={setRange} />
      </Toolbar>

      {q.isError && !data ? (
        <InsightsError error={q.error} onRetry={() => void q.refetch()} />
      ) : !data ? (
        <>
          <HeadlineSkeleton />
          <Panel title={t(`${K}.table.titleList`, { defaultValue: "How do departments compare?" })} bodyPadding={0}>
            <table className="table">
              <tbody>
                <SkeletonRows cols={8} rows={8} />
              </tbody>
            </table>
          </Panel>
        </>
      ) : rows.length === 0 ? (
        <div className="card ins-page-state">
          <PanelEmpty
            icon="users"
            title={t(`${K}.empty.title`, { defaultValue: "No departments in scope" })}
            body={t(`${K}.empty.body`, { defaultValue: "There are no departments with employees you can see for this period." })}
          />
        </div>
      ) : (
        <>
          <DeptHeadline
            kpis={data.kpis}
            period={data.period}
            compare={compare}
            shift={data.shift ?? null}
            lateDepts={rows.filter((r) => r.late > 0).length}
            deptCount={rows.length}
          />

          {sparse && <SparseNotice single={single} isToday={range.end === todayIso()} />}
          <KeyFindings items={findings} max={6} />

          <Panel
            className="ind-section"
            title={
              <QuestionTitle
                question={t(`${K}.table.titleList`, { defaultValue: "How do departments compare?" })}
                answer={
                  compare
                    ? t(`${K}.table.subList`, {
                        defaultValue: "Change is in percentage points vs {{prev}} · the tick on each bar is the company average ({{avg}})",
                        prev: compare.label,
                        avg: fmtPct(companyAtt),
                      })
                    : t(`${K}.table.subListNoPrev`, { defaultValue: "The tick on each bar is the company average ({{avg}})", avg: fmtPct(companyAtt) })
                }
              />
            }
            actions={
              rows.length > 8 ? (
                <SearchField
                  value={search}
                  onChange={setSearch}
                  placeholder={t(`${K}.search`, { defaultValue: "Search departments" })}
                  clearLabel={t(`${K}.clearSearch`, { defaultValue: "Clear search" })}
                />
              ) : undefined
            }
            bodyPadding={0}
          >
            {shown.length === 0 ? (
              <PanelEmpty icon="search" title={t(`${K}.noMatch.title`, { defaultValue: "No departments match" })} />
            ) : (
              <div className="ins-table-wrap">
                <table className="table ins-table ind-dtable">
                  <thead>
                    <tr>
                      <SortTh label={t(`${K}.col.department`, { defaultValue: "Department" })} active={sort === "name"} asc={asc} onClick={() => setSortKey("name")} end={false} />
                      <SortTh label={t(`${K}.col.attendance`, { defaultValue: "Attendance" })} active={sort === "att"} asc={asc} onClick={() => setSortKey("att")} end={false} className="ind-col-att" />
                      <SortTh label={t(`${K}.col.change`, { defaultValue: "Change" })} active={sort === "delta"} asc={asc} onClick={() => setSortKey("delta")} />
                      <SortTh label={t(`${K}.col.punctuality`, { defaultValue: "On time" })} active={sort === "punct"} asc={asc} onClick={() => setSortKey("punct")} />
                      <SortTh label={t(`${K}.col.late`, { defaultValue: "Late" })} active={sort === "late"} asc={asc} onClick={() => setSortKey("late")} />
                      <SortTh label={t(`${K}.col.absent`, { defaultValue: "Absent" })} active={sort === "absent"} asc={asc} onClick={() => setSortKey("absent")} />
                      <SortTh label={t(`${K}.col.avgIn`, { defaultValue: "Avg arrival" })} active={sort === "avgIn"} asc={asc} onClick={() => setSortKey("avgIn")} />
                      <SortTh label={t(`${K}.col.overtime`, { defaultValue: "Overtime" })} active={sort === "ot"} asc={asc} onClick={() => setSortKey("ot")} />
                      <th className="ind-col-chev">
                        <span className="ind-sr">{t(`${K}.col.open`, { defaultValue: "Open" })}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr
                        key={r.id}
                        className="ins-click-row"
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest("a")) return;
                          open(r.id);
                        }}
                      >
                        <td>
                          <Link className="ind-dname" to={deptHref(r.id)} title={r.name}>
                            {r.name}
                          </Link>
                          <div className="ind-dsub">{t(`${K}.headcountShort`, { defaultValue: "{{count}} people", count: r.headcount })}</div>
                        </td>
                        <td
                          className="ind-col-att"
                          title={t(`${K}.tip.att`, {
                            defaultValue: "{{pct}} attendance · {{present}} present days · company {{company}}",
                            pct: fmtPct(r.att),
                            present: fmtNum(r.present),
                            company: fmtPct(companyAtt),
                          })}
                        >
                          <AttendanceBar pct={r.att} reference={companyAtt} />
                        </td>
                        <td className="ins-end">
                          {r.delta === null || (r.att === 0 && r.prevAtt === 0) ? (
                            <span className="ins-muted">—</span>
                          ) : (
                            <DeltaBadge
                              delta={r.delta}
                              unit="pts"
                              better="up"
                              size="sm"
                              title={t(`${K}.tip.prev`, { defaultValue: "Previous period: {{v}}", v: fmtPct(r.prevAtt) })}
                            />
                          )}
                        </td>
                        <td className="ins-end ins-num">{fmtPct(r.punct)}</td>
                        <td className={`ins-end ins-num${r.late > 0 ? "" : " ins-muted"}`}>{fmtNum(r.late)}</td>
                        <td className={`ins-end ins-num${r.absent > 0 ? "" : " ins-muted"}`}>{fmtNum(r.absent)}</td>
                        <td className="ins-end ins-num">{clock(r.avgIn)}</td>
                        <td className={`ins-end ins-num${r.otHours > 0 ? "" : " ins-muted"}`}>{dur(r.otHours * 60)}</td>
                        <td className="ind-col-chev" aria-hidden>
                          <Icon name="chevronRight" size={14} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="ins-strong">{t(`${K}.company`, { defaultValue: "Whole company" })}</td>
                      <td className="ind-col-att">
                        <AttendanceBar pct={companyAtt} />
                      </td>
                      <td className="ins-end">
                        {compare?.kpis.attendance_pct !== null && compare?.kpis.attendance_pct !== undefined ? (
                          <DeltaBadge delta={deltaOf(companyAtt, compare.kpis.attendance_pct)} unit="pts" better="up" size="sm" />
                        ) : (
                          <span className="ins-muted">—</span>
                        )}
                      </td>
                      <td className="ins-end ins-num ins-strong">{fmtPct(punctualityOf(data.kpis))}</td>
                      <td className="ins-end ins-num ins-strong">{fmtNum(data.kpis.late)}</td>
                      <td className="ins-end ins-num ins-strong">{fmtNum(data.kpis.absent)}</td>
                      <td className="ins-end ins-num ins-strong">{clock(data.kpis.avg_in ?? null)}</td>
                      <td className="ins-end ins-num ins-strong">{dur(data.kpis.ot_hours * 60)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Panel>

          {!single && heatmap && heatmap.dates.length > 1 && heatmap.rows.length > 0 && (
            <Panel
              className="ind-section"
              title={
                <QuestionTitle
                  question={t(`${K}.heat.title`, { defaultValue: "Which days were weak, and where?" })}
                  answer={t(`${K}.heat.sub`, {
                    defaultValue: "Attendance per department on each working day · weekends and holidays are left out · same order as the table",
                  })}
                />
              }
            >
              <DeptDayHeatmap heatmap={heatmap} range={range} />
            </Panel>
          )}
        </>
      )}
    </>
  );
}

type TFn = ReturnType<typeof useTranslation>["t"];

function listFindings(
  data: InsightsOverview,
  rows: DeptCalc[],
  companyAtt: number,
  weekdays: InsightsWeekday[],
  t: TFn,
  lang: string,
  deptHref: (id: number) => string,
): Finding[] {
  const out: Finding[] = [];
  const real = rows.filter((r) => r.headcount > 0);
  const link = (r: DeptCalc) => <NameLink to={deptHref(r.id)}>{r.name}</NameLink>;
  const byAtt = [...real].sort((a, b) => a.att - b.att || b.headcount - a.headcount);
  const lo = byAtt[0];
  const hi = byAtt[byAtt.length - 1];
  if (hi && lo && hi.id !== lo.id && hi.att > 0) {
    out.push({
      id: "best",
      tone: "good",
      text: (
        <>
          {link(hi)} {t(`${K}.f.best`, { defaultValue: "has the best attendance — {{pct}}.", pct: fmtPct(hi.att) })}
        </>
      ),
    });
  }
  if (lo && hi && lo.id !== hi.id && companyAtt - lo.att >= 5) {
    out.push({
      id: "worst",
      tone: "bad",
      text: (
        <>
          {link(lo)}{" "}
          {t(`${K}.f.worst`, {
            defaultValue: "is {{gap}} points below the company average ({{pct}} vs {{company}}).",
            gap: fmtNum(Math.round(companyAtt - lo.att)),
            pct: fmtPct(lo.att),
            company: fmtPct(companyAtt),
          })}
        </>
      ),
    });
  }
  const withDelta = real.filter((r) => r.delta !== null);
  const drop = [...withDelta].sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))[0];
  if (drop && (drop.delta ?? 0) <= -5) {
    out.push({
      id: "drop",
      tone: "bad",
      text: (
        <>
          {link(drop)}{" "}
          {t(`${K}.f.drop`, {
            defaultValue: "dropped {{n}} points on the previous period ({{prev}} → {{now}}).",
            n: fmtNum(Math.abs(Math.round(drop.delta ?? 0))),
            prev: fmtPct(drop.prevAtt),
            now: fmtPct(drop.att),
          })}
        </>
      ),
    });
  }
  const rise = [...withDelta].sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
  if (rise && (rise.delta ?? 0) >= 5) {
    out.push({
      id: "rise",
      tone: "good",
      text: (
        <>
          {link(rise)} {t(`${K}.f.rise`, { defaultValue: "improved by {{n}} points on the previous period.", n: fmtNum(Math.round(rise.delta ?? 0)) })}
        </>
      ),
    });
  }
  const totalLate = data.kpis.late;
  const mostLate = [...real].sort((a, b) => b.late - a.late)[0];
  if (mostLate && totalLate >= 5 && mostLate.late / totalLate >= 0.25) {
    out.push({
      id: "late",
      tone: "warn",
      text: (
        <>
          {link(mostLate)}{" "}
          {t(`${K}.f.lateShare`, {
            defaultValue: "accounts for {{share}} of all late arrivals ({{n}} of {{total}}).",
            share: fmtPct((mostLate.late / totalLate) * 100),
            n: fmtNum(mostLate.late),
            total: fmtNum(totalLate),
          })}
        </>
      ),
    });
  }
  const wd = data.period.is_single_day ? null : weakestWeekday(weekdays);
  if (wd) {
    out.push({
      id: "weekday",
      tone: "info",
      text: t(`${K}.f.weekday`, {
        defaultValue: "{{day}} is the weakest day of the week ({{pct}} attendance).",
        day: weekdayName(wd.weekday, lang),
        pct: fmtPct(wd.attendance_pct),
      }),
    });
  }
  const silent = real.filter((r) => r.present === 0).length;
  if (silent > 0 && !data.period.is_single_day) {
    out.push({
      id: "silent",
      tone: "neutral",
      text: t(`${K}.f.silent`, {
        defaultValue: "{{n}} of {{total}} departments had no camera sightings at all in this period.",
        n: fmtNum(silent),
        total: fmtNum(real.length),
      }),
    });
  }
  return out;
}

// ===========================================================================
// DETAIL VIEW
// ===========================================================================

function deptInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(and|of|the)$/i.test(w));
  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
  return ((words[0] ?? "")[0]! + (words[1] ?? "")[0]!).toUpperCase();
}

function DepartmentDetailView({ departmentId }: { departmentId: number }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const dur = useDurationFmt();
  const { range, preset, setRange } = useInsightsRange();
  const q = useInsightsDepartment(departmentId, range);
  const list = useInsightsOverview(range, null); // switcher + company fallback
  const overview = list.data;
  const [excPage, setExcPage] = useState(1);

  const data = q.data && q.data.department.id === departmentId ? q.data : undefined;
  const dept = data?.department;
  const notFound = q.isError && (q.error as { status?: number }).status === 404;
  const single = data?.period.is_single_day ?? range.start === range.end;

  const prevRange = useMemo(() => previousRange(range), [range]);
  const prevQ = useDepartmentAt(departmentId, prevRange, !!data && data.compare === undefined);

  const compare: InsightsCompare | null = useMemo(() => {
    if (!data) return null;
    if (data.compare !== undefined) return data.compare;
    return prevQ.data ? compareFromKpis(prevQ.data.kpis, prevQ.data.period) : null;
  }, [data, prevQ.data]);

  const company: InsightsBenchmark | null = useMemo(() => {
    if (data?.company !== undefined) return data.company;
    if (!overview) return null;
    return {
      attendance_pct: attendanceOf(overview.kpis),
      punctuality_pct: punctualityOf(overview.kpis),
      avg_in: overview.kpis.avg_in ?? null,
      avg_hours: overview.kpis.avg_hours,
    };
  }, [data, overview]);

  const switcherOptions = useMemo<Array<[string, string]>>(() => {
    const opts: Array<[string, string]> = [...(overview?.departments ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => [String(d.department_id), d.name]);
    if (dept && !opts.some(([v]) => v === String(dept.id))) opts.unshift([String(dept.id), dept.name]);
    return opts;
  }, [overview, dept]);

  const personHref = (id: number) => `/insights/people/${id}${rangeQuery(range)}`;
  const openPerson = (id: number) => navigate(personHref(id));
  const backHref = `/insights/departments${rangeQuery(range)}`;

  const watch = useMemo(() => (data ? watchlistOf(data) : null), [data]);
  const weekdays = useMemo(
    () => (data ? (data.weekday && data.weekday.length ? data.weekday : weekdayFromTrend(data.trend, i18n.language)) : []),
    [data, i18n.language],
  );
  const findings = useMemo(
    () => (data && watch ? detailFindings(data, watch, company, weekdays, t, i18n.language, personHref, dur) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, watch, company, weekdays, t, i18n.language, dur],
  );
  const sparse =
    !!data && data.department.headcount > 0 && (single ? data.kpis.present === 0 : attendanceOf(data.kpis) < 25);

  const reportName = `${t(`${K}.pdfName`, { defaultValue: "Attendance report" })} — ${
    data?.period.label ?? (range.start === range.end ? range.start : `${range.start} → ${range.end}`)
  } · ${dept?.name ?? ""}`;
  const stem = `attendance_${(dept?.code || dept?.name || String(departmentId)).replace(/[^\w-]+/g, "_")}_${range.start}${
    range.end !== range.start ? `_${range.end}` : ""
  }`;
  // Same 2-point bar as the shared WeekdayChart sentence, so they agree.
  const weakest = weakestWeekday(weekdays, 2);
  const punct = data ? punctualityOf(data.kpis) : null;

  return (
    <>
      <Link className="ind-back" to={backHref}>
        <span className="ind-back-ic" aria-hidden>
          <Icon name="chevronLeft" size={14} />
        </span>
        {t(`${K}.back`, { defaultValue: "All departments" })}
      </Link>

      {notFound ? (
        <div className="card ins-page-state">
          <PanelEmpty
            tone="warning"
            icon="info"
            title={t(`${K}.notFound.title`, { defaultValue: "Department not found" })}
            body={t(`${K}.notFound.body`, { defaultValue: "It doesn't exist or isn't in your scope." })}
            action={
              <button type="button" className="btn" onClick={() => navigate(backHref)}>
                {t(`${K}.back`, { defaultValue: "All departments" })}
              </button>
            }
          />
        </div>
      ) : (
        <>
          <section className="card ind-head">
            <span className="ind-head-badge" aria-hidden>
              {dept ? deptInitials(dept.name) : ""}
            </span>
            <div className="ind-head-main">
              {dept ? (
                <>
                  <h1 className="ind-head-name">{dept.name}</h1>
                  <div className="ind-head-meta">
                    <span>
                      <Icon name="users" size={13} />
                      {t(`${K}.head.headcount`, { defaultValue: "{{count}} people", count: dept.headcount })}
                    </span>
                    <span>
                      <Icon name="user" size={13} />
                      {dept.managers.length
                        ? t(`${K}.head.managedBy`, { defaultValue: "Managed by {{names}}", names: dept.managers.join(", ") })
                        : t(`${K}.head.noManagers`, { defaultValue: "No manager assigned" })}
                    </span>
                    {dept.code && <span className="ind-head-code">{dept.code}</span>}
                    {dept.division && <span>{dept.division}</span>}
                    {data && <span className="ind-head-period">{data.period.label}</span>}
                  </div>
                </>
              ) : q.isError ? (
                <h1 className="ind-head-name">{t(`${K}.error.title`, { defaultValue: "Couldn't load this department" })}</h1>
              ) : (
                <SkeletonLines lines={2} />
              )}
            </div>
            <div className="ind-head-side">
              {switcherOptions.length > 1 && (
                <FilterSelect
                  label={t(`${K}.switcher`, { defaultValue: "Department" })}
                  value={String(departmentId)}
                  onChange={(v) => {
                    if (v && v !== String(departmentId)) navigate(`/insights/departments/${v}${rangeQuery(range)}`);
                  }}
                  options={switcherOptions}
                />
              )}
              {dept && <DownloadPdfButton range={range} departmentId={departmentId} reportName={reportName} filenameStem={stem} />}
            </div>
          </section>

          <Toolbar fetching={q.isFetching && !!data}>
            <RangePicker range={range} preset={preset} onChange={setRange} />
          </Toolbar>

          {q.isError && !data ? (
            <InsightsError error={q.error} onRetry={() => void q.refetch()} />
          ) : !data || !watch ? (
            <>
              <HeadlineSkeleton />
              <div className="ind-row-2">
                <Panel title={t(`${K}.weekday.title`, { defaultValue: "Which day of the week is weakest?" })}>
                  <ChartSkeleton height={200} />
                </Panel>
                <Panel title={t(`${K}.arr.title`, { defaultValue: "Are people arriving on time?" })}>
                  <ChartSkeleton height={200} />
                </Panel>
              </div>
            </>
          ) : (
            <>
              <DeptHeadline kpis={data.kpis} period={data.period} compare={compare} shift={data.shift ?? null} company={company} />

              {sparse && <SparseNotice single={single} isToday={range.end === todayIso()} />}
              <KeyFindings items={findings} max={6} />

              <div className="ind-row-2">
                {!single && (
                  <Panel
                    title={
                      <QuestionTitle
                        question={t(`${K}.weekday.title`, { defaultValue: "Which day of the week is weakest?" })}
                        answer={
                          weakest
                            ? t(`${K}.weekday.answer`, {
                                defaultValue: "{{day}} — {{pct}} attendance",
                                day: weekdayName(weakest.weekday, i18n.language),
                                pct: fmtPct(weakest.attendance_pct),
                              })
                            : t(`${K}.weekday.answerFlat`, { defaultValue: "No weekday stands out" })
                        }
                      />
                    }
                  >
                    <WeekdayChart
                      days={weekdays}
                      reference={company?.attendance_pct ?? null}
                      referenceLabel={t(`${K}.weekday.companyRef`, { defaultValue: "Company average" })}
                    />
                  </Panel>
                )}
                <Panel
                  title={
                    <QuestionTitle
                      question={t(`${K}.arr.title`, { defaultValue: "Are people arriving on time?" })}
                      answer={
                        punct === null
                          ? t(`${K}.arr.answerNone`, { defaultValue: "No arrivals recorded" })
                          : data.shift
                            ? t(`${K}.arr.answerShift`, {
                                defaultValue: "{{pct}} on time · shift starts {{start}}, {{grace}} min grace",
                                pct: fmtPct(punct),
                                start: data.shift.start,
                                grace: data.shift.grace_minutes,
                              })
                            : t(`${K}.arr.answer`, { defaultValue: "{{pct}} on time", pct: fmtPct(punct) })
                      }
                    />
                  }
                >
                  <ArrivalChart buckets={data.arrivals} shift={data.shift ?? null} />
                </Panel>
              </div>

              <RosterTable data={data} single={single} watch={watch} personHref={personHref} />

              <div className="ind-section">
                <WatchlistPanel
                  watchlist={watch}
                  range={range}
                  single={single}
                  hideDepartment
                  title={t(`${K}.watch.title`, { defaultValue: "Who in this team needs a follow-up?" })}
                  {...(single ? { keys: ["frequent_late", "repeated_absent", "early_leavers", "overtime"] } : {})}
                />
              </div>

              <Panel
                className="ind-section"
                title={
                  <QuestionTitle
                    question={t(`${K}.exc.title`, { defaultValue: "Every exception, day by day" })}
                    answer={t(`${K}.exc.sub`, {
                      defaultValue: "Absences, late arrivals, early leaving and short days — {{n}} records",
                      n: fmtNum(data.exceptions_total),
                    })}
                  />
                }
                bodyPadding={0}
              >
                <ExceptionsTable
                  rows={data.exceptions}
                  total={data.exceptions_total}
                  showDate={!data.period.is_single_day}
                  showDepartment={false}
                  page={excPage}
                  onPageChange={setExcPage}
                  onOpenPerson={openPerson}
                />
              </Panel>
            </>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail: watchlist (v2 from the API, else derived from employees[])
// ---------------------------------------------------------------------------

function watchlistOf(d: InsightsDepartment): InsightsWatchlist {
  if (d.watchlist) return d.watchlist;
  const base = (e: InsightsDepartmentEmployee) => ({
    employee_id: e.employee_id,
    employee_code: e.employee_code,
    full_name: e.full_name,
    department: d.department.name,
    department_id: d.department.id,
    primary_photo_id: e.primary_photo_id,
  });
  const late = d.employees.filter((e) => e.late_days >= 2).sort((a, b) => b.late_days - a.late_days);
  const absent = d.employees.filter((e) => e.absent_days >= 2).sort((a, b) => b.absent_days - a.absent_days);
  const ot = d.employees.filter((e) => e.ot_hours > 0).sort((a, b) => b.ot_hours - a.ot_hours);
  const never = d.period.is_single_day ? [] : d.employees.filter((e) => e.present_days === 0 && e.absent_days > 0);
  return {
    frequent_late: late.slice(0, 10).map((e) => ({ ...base(e), count: e.late_days, avg_late_minutes: null })),
    repeated_absent: absent.slice(0, 10).map((e) => ({ ...base(e), count: e.absent_days, longest_streak: 0 })),
    early_leavers: [],
    overtime: ot.slice(0, 10).map((e) => ({ ...base(e), ot_minutes: Math.round(e.ot_hours * 60) })),
    never_seen: never.slice(0, 20).map(base),
    totals: { frequent_late: late.length, repeated_absent: absent.length, early_leavers: 0, overtime: ot.length, never_seen: never.length },
  };
}

function detailFindings(
  d: InsightsDepartment,
  w: InsightsWatchlist,
  company: InsightsBenchmark | null,
  weekdays: InsightsWeekday[],
  t: TFn,
  lang: string,
  personHref: (id: number) => string,
  dur: (min: number | null | undefined) => string,
): Finding[] {
  const out: Finding[] = [];
  const att = attendanceOf(d.kpis);
  const single = d.period.is_single_day;
  const person = (p: { employee_id: number; full_name: string }) => <NameLink to={personHref(p.employee_id)}>{p.full_name}</NameLink>;
  if (company?.attendance_pct !== null && company?.attendance_pct !== undefined) {
    const gap = Math.round(att - company.attendance_pct);
    if (Math.abs(gap) >= 3) {
      out.push({
        id: "company",
        tone: gap > 0 ? "good" : "bad",
        text:
          gap > 0
            ? t(`${K}.f.aboveCompany`, {
                defaultValue: "Attendance is {{n}} points above the company average ({{pct}} vs {{company}}).",
                n: fmtNum(gap),
                pct: fmtPct(att),
                company: fmtPct(company.attendance_pct),
              })
            : t(`${K}.f.belowCompany`, {
                defaultValue: "Attendance is {{n}} points below the company average ({{pct}} vs {{company}}).",
                n: fmtNum(-gap),
                pct: fmtPct(att),
                company: fmtPct(company.attendance_pct),
              }),
      });
    } else if (company.attendance_pct >= 1) {
      out.push({
        id: "company",
        tone: "neutral",
        text: t(`${K}.f.inLine`, { defaultValue: "Attendance is in line with the company average ({{pct}}).", pct: fmtPct(company.attendance_pct) }),
      });
    }
  }
  const wd = single ? null : weakestWeekday(weekdays);
  if (wd) {
    out.push({
      id: "weekday",
      tone: "info",
      text: t(`${K}.f.weekday`, {
        defaultValue: "{{day}} is the weakest day of the week ({{pct}} attendance).",
        day: weekdayName(wd.weekday, lang),
        pct: fmtPct(wd.attendance_pct),
      }),
    });
  }
  const thr = attentionThreshold(d.period.working_days);
  const lateN = d.employees.filter((e) => e.late_days >= thr).length;
  if (lateN > 0 && !single) {
    out.push({
      id: "late",
      tone: "warn",
      text: t(`${K}.f.lateRepeat`, {
        defaultValue: "{{n}} of {{total}} people were late {{thr}} or more times.",
        n: fmtNum(lateN),
        total: fmtNum(d.department.headcount),
        thr,
      }),
    });
  }
  const streak = [...w.repeated_absent].sort((a, b) => b.longest_streak - a.longest_streak)[0];
  if (streak && streak.longest_streak >= 3) {
    out.push({
      id: "streak",
      tone: "bad",
      text: (
        <>
          {person(streak)} {t(`${K}.f.streak`, { defaultValue: "was absent {{n}} working days in a row.", n: fmtNum(streak.longest_streak) })}
        </>
      ),
    });
  }
  if (w.totals.never_seen > 0 && !single) {
    out.push({
      id: "never",
      tone: "neutral",
      text: t(`${K}.f.neverSeen`, {
        defaultValue: "{{n}} of {{total}} people were never seen by any camera — their reference photos may be missing.",
        n: fmtNum(w.totals.never_seen),
        total: fmtNum(d.department.headcount),
      }),
    });
  }
  const ot = w.overtime[0];
  if (ot && ot.ot_minutes >= 60) {
    out.push({
      id: "ot",
      tone: "info",
      text: (
        <>
          {person(ot)} {t(`${K}.f.overtime`, { defaultValue: "worked the most overtime ({{v}}).", v: dur(ot.ot_minutes) })}
        </>
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detail: team roster with status strip + attention markers
// ---------------------------------------------------------------------------

type Reason = "late" | "absent" | "never_seen" | "early";

function reasonsFor(e: InsightsDepartmentEmployee, w: InsightsWatchlist, thr: number, single: boolean): Reason[] {
  const out: Reason[] = [];
  const never = !single && (w.never_seen.some((p) => p.employee_id === e.employee_id) || (e.present_days === 0 && e.absent_days > 0));
  if (never) out.push("never_seen");
  else if (e.absent_days >= thr) out.push("absent");
  if (e.late_days >= thr) out.push("late");
  const early = w.early_leavers.find((p) => p.employee_id === e.employee_id);
  if (early && early.count >= thr) out.push("early");
  return out;
}

const STRIP_CLASS: Record<string, string> = {
  present: "is-present",
  present_weekend: "is-present",
  present_holiday: "is-present",
  late: "is-late",
  early: "is-late",
  absent: "is-absent",
  leave: "is-leave",
  weekend: "is-off",
  holiday: "is-off",
};

/** Fixed-width day strip (fits 1–92 days in the same column width). */
function DayStrip({ strip, start }: { strip: InsightsStatus[]; start: string }) {
  const fmt = useDateFmt();
  const label = useStatusLabel();
  const { t } = useTranslation();
  const counts = strip.reduce<Record<string, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {});
  const summary = Object.entries(counts)
    .map(([s, n]) => `${label(s)} ${n}`)
    .join(" · ");
  return (
    <span className={`ind-strip${strip.length > 45 ? " is-tight" : ""}`} role="img" aria-label={t(`${K}.strip.aria`, { defaultValue: "Day by day: {{s}}", s: summary })}>
      {strip.map((s, i) => {
        const d = addDays(start, i);
        return <span key={d} className={`ind-strip-cell ${STRIP_CLASS[s] ?? "is-none"}`} title={`${fmt.short(d)} · ${label(s)}`} />;
      })}
    </span>
  );
}

function StripLegend() {
  const label = useStatusLabel();
  const items: Array<[string, string]> = [
    ["is-present", label("present")],
    ["is-late", label("late")],
    ["is-absent", label("absent")],
    ["is-leave", label("leave")],
    ["is-off", `${label("weekend")} / ${label("holiday")}`],
    ["is-none", label("no_record")],
  ];
  return (
    <div className="ind-strip-legend">
      {items.map(([cls, l]) => (
        <span key={cls}>
          <i className={`ind-strip-cell ${cls}`} aria-hidden />
          {l}
        </span>
      ))}
    </div>
  );
}

type RosterSort = "attention" | "name" | "att" | "punct" | "late" | "absent" | "avgIn" | "ot";

function RosterTable({
  data,
  single,
  watch,
  personHref,
}: {
  data: InsightsDepartment;
  single: boolean;
  watch: InsightsWatchlist;
  personHref: (id: number) => string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dur = useDurationFmt();
  const [sort, setSort] = useState<RosterSort>("attention");
  const [asc, setAsc] = useState(false);
  const [search, setSearch] = useState("");
  const thr = attentionThreshold(data.period.working_days);
  const showStrip = !single && data.employees.some((e) => Array.isArray(e.strip) && e.strip.length > 0);

  const enriched = useMemo(
    () =>
      data.employees.map((e) => ({
        e,
        reasons: reasonsFor(e, watch, thr, single),
        punct: e.punctuality_pct !== undefined ? e.punctuality_pct : pctOf(e.present_days - e.late_days, e.present_days),
      })),
    [data.employees, watch, thr, single],
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? enriched.filter(({ e }) => `${e.full_name} ${e.employee_code} ${e.designation ?? ""}`.toLowerCase().includes(needle))
      : [...enriched];
    type R = (typeof list)[number];
    const val = (r: R): number | string => {
      switch (sort) {
        case "attention": return r.reasons.length * 1000 + (100 - r.e.pct);
        case "name": return r.e.full_name.toLowerCase();
        case "att": return r.e.pct;
        case "punct": return r.punct ?? (asc ? Number.MAX_VALUE : -1);
        case "late": return r.e.late_days;
        case "absent": return r.e.absent_days;
        case "avgIn": return clockToMinutes(r.e.avg_in) ?? (asc ? Number.MAX_VALUE : -1);
        case "ot": return r.e.ot_hours;
      }
    };
    list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return (asc ? c : -c) || a.e.full_name.localeCompare(b.e.full_name);
    });
    return list;
  }, [enriched, search, sort, asc]);

  const setSortKey = (k: RosterSort) => {
    if (k === sort) setAsc((a) => !a);
    else {
      setSort(k);
      setAsc(k === "name" || k === "avgIn");
    }
  };
  const flagged = enriched.filter((r) => r.reasons.length > 0).length;

  return (
    <Panel
      className="ind-section"
      title={
        <QuestionTitle
          question={t(`${K}.roster.title`, { defaultValue: "How is each person doing?" })}
          answer={
            flagged > 0
              ? t(`${K}.roster.subFlagged`, {
                  defaultValue: "{{n}} of {{total}} people need attention and are listed first · click a name for their page",
                  n: fmtNum(flagged),
                  total: fmtNum(data.employees.length),
                })
              : t(`${K}.roster.sub`, { defaultValue: "{{total}} people, nobody flagged · click a name for their page", total: fmtNum(data.employees.length) })
          }
        />
      }
      actions={
        data.employees.length > 8 ? (
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t(`${K}.roster.search`, { defaultValue: "Search name, ID or designation" })}
            clearLabel={t(`${K}.clearSearch`, { defaultValue: "Clear search" })}
          />
        ) : undefined
      }
      bodyPadding={0}
    >
      {data.employees.length === 0 ? (
        <PanelEmpty icon="users" title={t(`${K}.roster.empty`, { defaultValue: "No employees in this department" })} />
      ) : rows.length === 0 ? (
        <PanelEmpty icon="search" title={t(`${K}.roster.noMatch`, { defaultValue: "Nobody matches that search" })} />
      ) : (
        <div className="ins-table-wrap">
          <table className="table ins-table ind-roster">
            <thead>
              <tr>
                <SortTh label={t(`${K}.roster.employee`, { defaultValue: "Employee" })} active={sort === "name"} asc={asc} onClick={() => setSortKey("name")} end={false} />
                {showStrip && <th className="ind-col-strip">{t(`${K}.roster.pattern`, { defaultValue: "Day by day" })}</th>}
                <SortTh label={t(`${K}.col.attendance`, { defaultValue: "Attendance" })} active={sort === "att"} asc={asc} onClick={() => setSortKey("att")} />
                <SortTh label={t(`${K}.col.punctuality`, { defaultValue: "On time" })} active={sort === "punct"} asc={asc} onClick={() => setSortKey("punct")} />
                <SortTh label={t(`${K}.col.late`, { defaultValue: "Late" })} active={sort === "late"} asc={asc} onClick={() => setSortKey("late")} />
                <SortTh label={t(`${K}.col.absent`, { defaultValue: "Absent" })} active={sort === "absent"} asc={asc} onClick={() => setSortKey("absent")} />
                <SortTh label={t(`${K}.col.avgIn`, { defaultValue: "Avg arrival" })} active={sort === "avgIn"} asc={asc} onClick={() => setSortKey("avgIn")} />
                <SortTh label={t(`${K}.col.overtime`, { defaultValue: "Overtime" })} active={sort === "ot"} asc={asc} onClick={() => setSortKey("ot")} />
                <SortTh label={t(`${K}.roster.attention`, { defaultValue: "Needs attention" })} active={sort === "attention"} asc={asc} onClick={() => setSortKey("attention")} end={false} />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ e, reasons, punct }) => (
                <tr
                  key={e.employee_id}
                  className="ins-click-row"
                  onClick={(ev) => {
                    if ((ev.target as HTMLElement).closest("a")) return;
                    navigate(personHref(e.employee_id));
                  }}
                >
                  <td>
                    <span className="ind-person">
                      <PersonAvatar name={e.full_name} employeeId={e.employee_id} photoId={e.primary_photo_id} size={30} />
                      <span className="ind-person-text">
                        <Link className="ind-person-name" to={personHref(e.employee_id)} title={e.full_name}>
                          {e.full_name}
                        </Link>
                        <span className="ind-person-code">
                          {e.employee_code}
                          {e.designation ? ` · ${e.designation}` : ""}
                        </span>
                      </span>
                    </span>
                  </td>
                  {showStrip && (
                    <td className="ind-col-strip">
                      {e.strip && e.strip.length ? <DayStrip strip={e.strip} start={data.period.start} /> : <span className="ins-muted">—</span>}
                    </td>
                  )}
                  <td className="ins-end ins-num ins-strong">{fmtPct(e.pct)}</td>
                  <td className="ins-end ins-num">{fmtPct(punct)}</td>
                  <td className={`ins-end ins-num${e.late_days > 0 ? "" : " ins-muted"}`}>{fmtNum(e.late_days)}</td>
                  <td className={`ins-end ins-num${e.absent_days > 0 ? "" : " ins-muted"}`}>{fmtNum(e.absent_days)}</td>
                  <td className="ins-end ins-num">{clock(e.avg_in)}</td>
                  <td className={`ins-end ins-num${e.ot_hours > 0 ? "" : " ins-muted"}`}>{dur(e.ot_hours * 60)}</td>
                  <td>
                    {reasons.length === 0 ? (
                      <span className="ind-ok" title={t(`${K}.reason.none`, { defaultValue: "No concerns" })}>
                        <Icon name="check" size={12} />
                        <span className="ind-sr">{t(`${K}.reason.none`, { defaultValue: "No concerns" })}</span>
                      </span>
                    ) : (
                      <AttentionChips reasons={reasons} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {showStrip && <StripLegend />}
        </div>
      )}
    </Panel>
  );
}
