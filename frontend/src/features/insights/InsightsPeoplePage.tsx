// MaugoodAI Insights — Person-based dashboard (v2).
//
//   /insights/people              → people list for a period: attendance %,
//                                   punctuality %, late/absent counts, avg
//                                   arrival and "needs attention" reasons;
//                                   search + department filter + sort
//                                   (default: needs attention first) + paging.
//                                   Recently viewed chips stay.
//   /insights/people/:employeeId  → one employee over a range: profile +
//                                   policy, 4 headline metrics vs previous
//                                   period / department, plain-language
//                                   highlights, calendar heatmap, arrival-time
//                                   chart, filterable daily table, requests.
//
// Every figure comes from GET /api/insights/people and
// GET /api/insights/employees/{id}, which reuse the PDF context builders
// (reporting/pdf.py) — this page never derives attendance itself, it only
// lays the server's rows out.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { extractApiError } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { todayIso } from "../../components/DatePicker";
import { FilterSelect, SearchField } from "../../components/ListPageUi";
import { SkeletonChart, SkeletonLine, SkeletonTable } from "../../components/Skeleton";
import { NewRequestDrawer } from "../../requests/NewRequestDrawer";
import { Icon } from "../../shell/Icon";
import { DayDetailDrawer } from "../calendar/DayDetailDrawer";
import { TONE } from "../calendar/calendarUi";
import type { SummaryKey } from "../calendar/calendarUi";
import { useDepartments } from "../departments/hooks";
import { useInsightsEmployee, useInsightsPeople } from "./hooks";
import type { InsightsRange } from "./hooks";
import {
  AttentionChips,
  DownloadPdfButton,
  HeadlineMetric,
  HeadlineRow,
  HeadlineSkeleton,
  InsightsError,
  InsightsNotice,
  KeyFindings,
  QuestionTitle,
  PersonAvatar,
  RangePicker,
  StatusPill,
  detectPreset,
  presetRange,
  rangeQuery,
  useInsightsRange,
  useStatusLabel,
  useWidth,
} from "./insightsUi";
import type { Finding, HeadlineComparison } from "./insightsUi";
import type { InsightsEmployee, InsightsEmployeeDay, InsightsPeopleItem, InsightsPeopleSort } from "./types";

import "./people.css";

// Local aliases over the shared v2 wire types.
type PeopleItem = InsightsPeopleItem;
type PersonDay = InsightsEmployeeDay;
/** The profile may carry ``department_id`` (linked when present). */
type PersonV2 = Omit<InsightsEmployee, "profile"> & {
  profile: InsightsEmployee["profile"] & { department_id?: number | null };
};

const SORTS: InsightsPeopleSort[] = ["attention", "name", "attendance", "punctuality", "late", "absent"];
const PAGE_SIZE = 24;

// ---------------------------------------------------------------------------
// Range — shared ?start=&end= hook; with no range in the URL a person page
// opens on "This month" (one day is too thin for a person view).
// ---------------------------------------------------------------------------

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

function usePersonRange(): { range: InsightsRange; setRange: (r: InsightsRange) => void; preset: ReturnType<typeof detectPreset> } {
  const [params] = useSearchParams();
  const shared = useInsightsRange();
  const hasRange = Boolean(params.get("start") || params.get("end"));
  const range = hasRange ? shared.range : presetRange("month");
  return { range, setRange: shared.setRange, preset: hasRange ? shared.preset : "month" };
}

// ---------------------------------------------------------------------------
// Recently viewed people (localStorage, last 5)
// ---------------------------------------------------------------------------

interface RecentPerson {
  id: number;
  name: string;
  code: string;
  photoId: number | null;
}
const RECENT_KEY = "maugood.insights.recentPeople";

function readRecent(): RecentPerson[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is RecentPerson => typeof r === "object" && r !== null && typeof (r as RecentPerson).id === "number" && typeof (r as RecentPerson).name === "string")
      .slice(0, 5);
  } catch {
    return [];
  }
}
function pushRecent(p: RecentPerson): void {
  try {
    const next = [p, ...readRecent().filter((r) => r.id !== p.id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode — nothing to remember */
  }
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/** "07:32", "07:32:10" or an ISO datetime → minutes since midnight. */
function toMin(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.includes("T") ? v.split("T")[1] ?? "" : v;
  const m = /(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function clockOf(mins: number): string {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function hhmm(v: string | null | undefined): string {
  const m = toMin(v);
  return m === null ? "—" : clockOf(m);
}
function pct(n: number | null | undefined): string {
  return n === null || n === undefined || Number.isNaN(n) ? "—" : `${Math.round(n)}%`;
}
/** Minutes → "6h 47m" / "45m". */
function fmtMinutes(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || Number.isNaN(mins)) return "—";
  const total = Math.round(Math.abs(mins));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
}
/** Hours (decimal) → "6h 47m". */
function fmtHoursDur(h: number | null | undefined): string {
  return h === null || h === undefined || Number.isNaN(h) ? "—" : fmtMinutes(h * 60);
}

/** "16:00–23:59" → [start, end] minutes (end +24h when it wraps). */
function parseWindow(w: string | null | undefined): [number, number] | null {
  if (!w) return null;
  const parts = w.split(/\s*[–—-]\s*/);
  const a = toMin(parts[0]);
  const b = toMin(parts[1]);
  if (a === null || b === null) return null;
  return [a, b <= a ? b + 1440 : b];
}

type Tone = SummaryKey | "neutral";

function toneOf(status: string): Tone {
  switch (status) {
    case "present":
    case "present_weekend":
    case "present_holiday":
    case "early":
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
      return "weekend";
    default:
      return "neutral";
  }
}


/** Flags arrive as strings, [kind, label] tuples or {kind,label}. */
function flagKind(f: unknown): string | null {
  if (typeof f === "string") return f.split(/[\s:]/)[0]?.toLowerCase() ?? f;
  if (Array.isArray(f) && typeof f[0] === "string") return f[0];
  if (f && typeof f === "object") {
    const o = f as { kind?: unknown; key?: unknown };
    if (typeof o.kind === "string") return o.kind;
    if (typeof o.key === "string") return o.key;
  }
  return null;
}
function flagsOf(d: InsightsEmployeeDay): string[] {
  return ((d.flags ?? []) as unknown[]).map(flagKind).filter((k): k is string => k !== null);
}

function useLocaleTag(): string {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("ar") ? "ar-OM" : "en-GB";
}

/** "Mon".."Sun" → localised long weekday name. 2026-10-05 is a Monday. */
function useWeekdayName(): (short: string | null | undefined) => string {
  const loc = useLocaleTag();
  return (short) => {
    if (!short) return "";
    const idx = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(short.slice(0, 3).toLowerCase());
    if (idx < 0) return short;
    return new Date(2026, 9, 5 + idx).toLocaleDateString(loc, { weekday: "long" });
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function InsightsPeoplePage() {
  const { employeeId } = useParams<{ employeeId?: string }>();
  const id = employeeId && /^\d+$/.test(employeeId) ? Number(employeeId) : null;
  return id === null ? <PeopleList /> : <PersonDetail employeeId={id} />;
}

// ---------------------------------------------------------------------------
// People list
// ---------------------------------------------------------------------------

function PeopleList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const departments = useDepartments();
  const { range, preset, setRange } = usePersonRange();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [recent] = useState<RecentPerson[]>(() => readRecent());

  const rawDept = params.get("department_id");
  const departmentId = rawDept && /^\d+$/.test(rawDept) ? Number(rawDept) : null;
  const rawSort = params.get("sort") as InsightsPeopleSort | null;
  const sort: InsightsPeopleSort = rawSort && SORTS.includes(rawSort) ? rawSort : "attention";
  const rawPage = Number(params.get("page") ?? "1");
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const patch = (changes: Record<string, string | null>, resetPage = true) =>
    setParams((prev) => {
      const sp = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === "") sp.delete(k);
        else sp.set(k, v);
      }
      if (resetPage) sp.delete("page");
      // Keep the visible range in the URL so links stay shareable.
      if (!sp.get("start")) {
        sp.set("start", range.start);
        sp.set("end", range.end);
      }
      return sp;
    });

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);
  const [lastQ, setLastQ] = useState("");
  useEffect(() => {
    if (debouncedQ !== lastQ) {
      setLastQ(debouncedQ);
      if (page !== 1) patch({}, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const list = useInsightsPeople(range, { departmentId, q: debouncedQ, sort, page, pageSize: PAGE_SIZE });
  const data = list.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.page_size ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const deptOptions = useMemo<Array<[string, string]>>(() => {
    const all = departments.data?.items ?? [];
    const allowed = me.data?.active_role === "Manager" ? new Set(me.data?.departments ?? []) : null;
    const opts = all
      .filter((d) => !allowed || allowed.has(d.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => [String(d.id), d.name] as [string, string]);
    return [["", t("insights.filter.allDepartments", { defaultValue: "All departments" }) as string], ...opts];
  }, [departments.data, me.data, t]);

  const sortOptions: Array<[string, string]> = [
    ["attention", t("insights.people.sort.attention", { defaultValue: "Needs attention first" }) as string],
    ["name", t("insights.people.sort.name", { defaultValue: "Name (A–Z)" }) as string],
    ["attendance", t("insights.people.sort.attendance", { defaultValue: "Lowest attendance" }) as string],
    ["punctuality", t("insights.people.sort.punctuality", { defaultValue: "Lowest punctuality" }) as string],
    ["late", t("insights.people.sort.late", { defaultValue: "Most late days" }) as string],
    ["absent", t("insights.people.sort.absent", { defaultValue: "Most absent days" }) as string],
  ];

  const qs = rangeQuery(range);
  const open = (p: RecentPerson) => {
    pushRecent(p);
    navigate(`/insights/people/${p.id}${qs}`);
  };
  const openItem = (e: PeopleItem) => open({ id: e.employee_id, name: e.full_name, code: e.employee_code, photoId: e.primary_photo_id });

  // Sparse data reads calmly: when most people on the page were never seen
  // by a camera, say so once instead of painting a wall of red.
  const neverSeen = items.filter((i) => i.present_days === 0 && (i.attendance_pct ?? 0) === 0).length;
  const sparse = items.length >= 4 && neverSeen / items.length >= 0.6;
  const attentionCount = items.filter((i) => i.needs_attention).length;

  const sortHeader = (key: InsightsPeopleSort, label: string, end = false) => (
    <th className={end ? "insp-end" : undefined} aria-sort={sort === key ? "descending" : "none"}>
      <button type="button" className={`insp-th-sort${sort === key ? " is-active" : ""}`} onClick={() => patch({ sort: key === "attention" ? null : key })}>
        {label}
        {sort === key && <Icon name="chevronDown" size={11} />}
      </button>
    </th>
  );

  return (
    <div className="insp-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("insights.people.title", { defaultValue: "Employee insights" }) as string}</h1>
          <p className="page-sub">
            {t("insights.people.subtitleV2", {
              defaultValue: "Who is on time, who is often late or absent, and who has not been seen by any camera — pick a person for the full picture.",
            }) as string}
          </p>
        </div>
      </div>

      <div className="insp-toolbar-row">
        <RangePicker range={range} preset={preset} onChange={setRange} />
        <FilterSelect
          label={t("insights.filter.department", { defaultValue: "Department" }) as string}
          value={departmentId !== null ? String(departmentId) : ""}
          onChange={(v) => patch({ department_id: v || null })}
          options={deptOptions}
        />
        <FilterSelect
          label={t("insights.people.sortLabel", { defaultValue: "Sort" }) as string}
          value={sort === "attention" ? "" : sort}
          onChange={(v) => patch({ sort: v === "attention" ? null : v || null })}
          options={sortOptions.map(([v, l]) => [v === "attention" ? "" : v, l] as [string, string])}
        />
        {list.isFetching && data && (
          <span className="ins-fetching" role="status">
            <Icon name="refresh" size={12} />
            {t("insights.updating", { defaultValue: "Updating…" }) as string}
          </span>
        )}
      </div>

      {recent.length > 0 && (
        <div className="insp-recent">
          <span className="insp-recent-label">{t("insights.people.recent", { defaultValue: "Recently viewed" }) as string}</span>
          {recent.map((r) => (
            <button key={r.id} type="button" className="insp-chip" onClick={() => open(r)} title={r.name}>
              <PersonAvatar employeeId={r.id} name={r.name} photoId={r.photoId} size={24} />
              {r.name}
              <span className="mono">{r.code}</span>
            </button>
          ))}
        </div>
      )}

      <div className="card insp-list-card">
        <div className="insp-list-head">
          <SearchField
            value={q}
            onChange={setQ}
            placeholder={t("insights.people.search", { defaultValue: "Search by name, employee ID or department…" }) as string}
            clearLabel={t("common.clear", { defaultValue: "Clear" }) as string}
          />
          {data && (
            <span className="insp-list-meta">
              <b>{data.period.label}</b>
              <span>·</span>
              {t("insights.people.countPeople", { count: total, defaultValue: `${total.toLocaleString()} people` }) as string}
              {sort === "attention" && attentionCount > 0 && !sparse && (
                <>
                  <span>·</span>
                  <span className="insp-attn-count">
                    {t("insights.people.attentionOnPage", { count: attentionCount, defaultValue: `${attentionCount} need attention on this page` }) as string}
                  </span>
                </>
              )}
            </span>
          )}
        </div>

        {sparse && (
          <InsightsNotice
            tone="neutral"
            title={t("insights.people.sparseTitle", { defaultValue: "Most people here have no camera sightings in this period" }) as string}
            body={t("insights.people.sparseBody", {
              defaultValue: "That usually means missing reference photos or a camera that does not cover the entrance — not that everyone was absent. Check Employees → photos and the camera list.",
            }) as string}
          />
        )}

        {list.isLoading && <SkeletonTable rows={10} cols={8} />}
        {list.isError && !data && (
          <InsightsError
            error={new Error(extractApiError(list.error, t("insights.people.loadFailed", { defaultValue: "Could not load employees." }) as string))}
            onRetry={() => void list.refetch()}
          />
        )}
        {data && items.length === 0 && (
          <div className="insp-empty">{t("insights.people.empty", { defaultValue: "No employees match. Try a different search or department." }) as string}</div>
        )}
        {items.length > 0 && (
          <div className="insp-table-wrap">
            <table className="table insp-people-table" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              <thead>
                <tr>
                  {sortHeader("name", t("insights.people.col.person", { defaultValue: "Person" }) as string)}
                  <th>{t("insights.people.col.department", { defaultValue: "Department" }) as string}</th>
                  {sortHeader("attendance", t("insights.people.col.attendance", { defaultValue: "Attendance" }) as string)}
                  {sortHeader("punctuality", t("insights.people.col.punctuality", { defaultValue: "On time" }) as string, true)}
                  {sortHeader("late", t("insights.people.col.late", { defaultValue: "Late" }) as string, true)}
                  {sortHeader("absent", t("insights.people.col.absent", { defaultValue: "Absent" }) as string, true)}
                  <th className="insp-end">{t("insights.people.col.avgIn", { defaultValue: "Avg arrival" }) as string}</th>
                  {sortHeader("attention", t("insights.people.col.attention", { defaultValue: "Needs attention" }) as string)}
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const att = e.attendance_pct;
                  const attTone = att === null ? "" : att >= 90 ? "is-good" : att >= 75 ? "is-warn" : e.present_days === 0 ? "is-quiet" : "is-bad";
                  return (
                    <tr
                      key={e.employee_id}
                      tabIndex={0}
                      onClick={() => openItem(e)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          openItem(e);
                        }
                      }}
                      aria-label={e.full_name}
                    >
                      <td>
                        <span className="insp-person">
                          <PersonAvatar employeeId={e.employee_id} name={e.full_name} photoId={e.primary_photo_id} size={34} />
                          <span className="insp-person-text">
                            <Link
                              className="insp-person-name"
                              to={`/insights/people/${e.employee_id}${qs}`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                pushRecent({ id: e.employee_id, name: e.full_name, code: e.employee_code, photoId: e.primary_photo_id });
                              }}
                              title={e.full_name}
                            >
                              {e.full_name}
                            </Link>
                            <span className="insp-person-meta">
                              <span className="mono">{e.employee_code}</span>
                              {e.designation ? ` · ${e.designation}` : ""}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="insp-dept-cell" title={e.department}>
                        {e.department_id !== null ? (
                          <Link to={`/insights/departments/${e.department_id}${qs}`} onClick={(ev) => ev.stopPropagation()}>
                            {e.department}
                          </Link>
                        ) : (
                          e.department
                        )}
                      </td>
                      <td>
                        <span className={`insp-att ${attTone}`} title={t("insights.people.attTip", { p: e.present_days, defaultValue: `${e.present_days} days present` }) as string}>
                          <span className="insp-att-bar" aria-hidden>
                            <span style={{ width: `${Math.max(0, Math.min(100, att ?? 0))}%` }} />
                          </span>
                          <b>{pct(att)}</b>
                        </span>
                      </td>
                      <td className="insp-num insp-end">{pct(e.punctuality_pct)}</td>
                      <td className={`insp-num insp-end${e.late_days > 0 ? " insp-late" : " insp-dim"}`}>{e.late_days}</td>
                      <td className={`insp-num insp-end${e.absent_days > 0 && e.present_days > 0 ? " insp-bad" : e.absent_days > 0 ? "" : " insp-dim"}`}>{e.absent_days}</td>
                      <td className={`insp-num insp-end${e.avg_in ? "" : " insp-dim"}`}>{hhmm(e.avg_in)}</td>
                      <td>
                        {e.attention_reasons.length > 0 ? (
                          <AttentionChips reasons={e.attention_reasons.includes("never_seen") ? ["never_seen"] : e.attention_reasons} />
                        ) : (
                          <span className="insp-ok">
                            <Icon name="check" size={12} />
                            {t("insights.people.allGood", { defaultValue: "On track" }) as string}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="insp-pager">
            <span className="text-dim">
              {t("insights.people.pageOf", {
                from: (page - 1) * pageSize + 1,
                to: Math.min(total, page * pageSize),
                total,
                defaultValue: `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`,
              }) as string}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => patch({ page: page - 1 > 1 ? String(page - 1) : null }, false)}>
                <Icon name="chevronLeft" size={11} />
                {t("common.previous", { defaultValue: "Previous" }) as string}
              </button>
              <button type="button" className="btn btn-sm" disabled={page >= totalPages} onClick={() => patch({ page: String(page + 1) }, false)}>
                {t("common.next", { defaultValue: "Next" }) as string}
                <Icon name="chevronRight" size={11} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function PersonDetail({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const me = useMe();
  const { range, preset, setRange } = usePersonRange();
  const { start, end } = range;
  const today = todayIso();
  const q = useInsightsEmployee(employeeId, range);
  const data = q.data && q.data.profile.id === employeeId ? (q.data as unknown as PersonV2) : undefined;
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [exceptionDate, setExceptionDate] = useState<string | null>(null);
  const [crop, setCrop] = useState<{ id: number; label: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    pushRecent({ id: data.profile.id, name: data.profile.full_name, code: data.profile.employee_code, photoId: data.profile.primary_photo_id });
  }, [data]);

  const backQs = (() => {
    const p = new URLSearchParams();
    const s = params.get("start");
    const e = params.get("end");
    if (s) p.set("start", s);
    if (e) p.set("end", e);
    return p.toString() ? `?${p.toString()}` : "";
  })();

  // "Submit exception" files a request for the signed-in user's own
  // employee record, so it is only offered on your own page.
  const isSelf = Boolean(
    data?.profile.email && me.data?.email && data.profile.email.toLowerCase() === me.data.email.toLowerCase(),
  );

  const notFound = q.error && (q.error as { status?: number }).status === 404;
  // Days before the person joined are not part of their record.
  const days = useMemo(() => (data ? data.days.filter((d) => !d.before_joining) : []), [data]);
  const hiddenBeforeJoining = data ? data.days.length - days.length : 0;

  return (
    <div className="insp-page">
      <div className="insp-toolbar">
        <button type="button" className="insp-back" onClick={() => navigate(`/insights/people${backQs}`)}>
          <Icon name="chevronLeft" size={13} />
          {t("insights.people.back", { defaultValue: "All people" }) as string}
        </button>
        <div className="insp-toolbar-actions">
          <RangePicker range={range} preset={preset} onChange={setRange} />
          <div className="insp-pdf">
            <DownloadPdfButton
              range={range}
              employeeId={employeeId}
              reportName={`${t("insights.people.pdfName", { defaultValue: "Employee report" }) as string} — ${data?.profile.full_name ?? employeeId} · ${start} → ${end}`}
              filenameStem={`employee_report_${data?.profile.employee_code ?? employeeId}_${start}_to_${end}`}
            />
          </div>
        </div>
      </div>

      <ProfileHeader data={data} range={range} />

      {q.isError &&
        (notFound ? (
          <div className="card insp-error" role="alert">
            <span>{t("insights.people.notFound", { defaultValue: "This employee was not found, or is outside your scope." }) as string}</span>
          </div>
        ) : (
          <InsightsError error={new Error(extractApiError(q.error, t("insights.people.loadFailedDetail", { defaultValue: "Could not load insights." }) as string))} onRetry={() => void q.refetch()} />
        ))}

      {!data && q.isLoading && (
        <>
          <HeadlineSkeleton />
          <div className="insp-row">
            <SkeletonChart height={280} />
            <SkeletonChart height={280} />
          </div>
          <SkeletonTable rows={8} cols={8} />
        </>
      )}

      {data && (
        <div className="insp-detail-body" style={{ opacity: q.isFetching && q.isPlaceholderData ? 0.6 : 1 }}>
          <HeadlineMetrics data={data} />
          <Highlights data={data} />
          <ArrivalChart data={data} days={days} onOpen={setOpenDay} />
          <CalendarHeatmap days={days} today={today} onOpen={setOpenDay} />
          <DailyTable days={days} hiddenBeforeJoining={hiddenBeforeJoining} joiningDate={data.profile.joining_date} onOpen={setOpenDay} onCrop={setCrop} />
          <RequestsPanel requests={data.requests} />
        </div>
      )}

      {openDay !== null && (
        <DayDetailDrawer
          employeeId={employeeId}
          isoDate={openDay}
          onClose={() => setOpenDay(null)}
          {...(isSelf && {
            onSubmitException: (iso: string) => {
              setExceptionDate(iso);
              setOpenDay(null);
            },
          })}
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
      {crop && <CropLightbox crop={crop} onClose={() => setCrop(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile header + policy
// ---------------------------------------------------------------------------

function ProfileHeader({ data, range }: { data: PersonV2 | undefined; range: InsightsRange }) {
  const { t } = useTranslation();
  const loc = useLocaleTag();
  if (!data) {
    return (
      <div className="card insp-profile">
        <div style={{ display: "flex", alignItems: "center", gap: 18, flex: 1 }}>
          <SkeletonLine width={72} height={72} radius="50%" />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
            <SkeletonLine width={220} height={20} />
            <SkeletonLine width={300} />
            <SkeletonLine width={260} />
          </div>
        </div>
      </div>
    );
  }
  const p = data.profile;
  const joined = p.joining_date ? parseIso(p.joining_date).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" }) : null;
  return (
    <div className="card insp-profile">
      <PersonAvatar employeeId={p.id} name={p.full_name} photoId={p.primary_photo_id} size={72} />
      <div className="insp-profile-who">
        <div className="insp-profile-name">{p.full_name}</div>
        <div className="insp-profile-line">
          <span className="mono">{p.employee_code}</span>
          {" · "}
          {p.designation || (t("insights.people.employee", { defaultValue: "Employee" }) as string)}
          {" · "}
          {p.department_id ? (
            <Link to={`/insights/departments/${p.department_id}${rangeQuery(range)}`}>{p.department || "—"}</Link>
          ) : (
            <span>{p.department || "—"}</span>
          )}
        </div>
        <div className="insp-profile-facts">
          {p.reports_to && (
            <span>
              {t("insights.people.reportsTo", { defaultValue: "Reports to" }) as string} <b>{p.reports_to}</b>
            </span>
          )}
          {joined && (
            <span>
              {t("insights.people.joined", { defaultValue: "Joined" }) as string} <b>{joined}</b>
            </span>
          )}
          <span>
            {t("insights.people.periodLabel", { defaultValue: "Period" }) as string} <b>{data.period.label}</b>
          </span>
        </div>
      </div>
      {data.policy ? (
        <div className="insp-policy" title={`${data.policy.name} (${data.policy.type})`}>
          <div className="insp-policy-head">
            <Icon name="clock" size={13} />
            <b>{data.policy.name}</b>
            <span className="insp-policy-type">{data.policy.type}</span>
          </div>
          <dl>
            <div>
              <dt>{t("insights.people.shift", { defaultValue: "Shift" }) as string}</dt>
              <dd className="insp-num">{data.policy.window}</dd>
            </div>
            <div>
              <dt>{t("insights.people.graceLabel", { defaultValue: "Grace" }) as string}</dt>
              <dd>{t("insights.people.graceMin", { n: data.policy.grace_minutes, defaultValue: `${data.policy.grace_minutes} min` }) as string}</dd>
            </div>
            <div>
              <dt>{t("insights.people.requiredLabel", { defaultValue: "Required" }) as string}</dt>
              <dd>{t("insights.people.requiredH", { n: data.policy.required_hours, defaultValue: `${data.policy.required_hours} h / day` }) as string}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <div className="insp-policy is-none">{t("insights.people.noPolicy", { defaultValue: "No shift policy applied" }) as string}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headline metrics (4) — vs previous period and vs department average
// ---------------------------------------------------------------------------

function HeadlineMetrics({ data }: { data: PersonV2 }) {
  const { t } = useTranslation();
  const k = data.kpis;
  const prev = data.compare?.previous ?? null;
  const dept = data.compare?.department ?? null;
  const noSightings = k.present_days === 0;
  const win = parseWindow(data.policy?.window);
  const shiftStart = win ? win[0] : null;
  const avgIn = toMin(k.avg_in);

  const vsPrev = t("insights.people.vsPrev", { defaultValue: "vs last period" }) as string;
  const vsDept = t("insights.people.vsDept", { defaultValue: "vs department" }) as string;
  const prevTitle = prev?.label
    ? (t("insights.people.prevTitle", { p: prev.label, defaultValue: `Previous period: ${prev.label}` }) as string)
    : (t("insights.people.prevTitleNoLabel", { defaultValue: "Previous period of the same length" }) as string);
  const deptTitle = (v: string) =>
    t("insights.people.deptTitle", { dept: data.profile.department, v, defaultValue: `${data.profile.department} average: ${v}` }) as string;
  const diff = (a: number | null | undefined, b: number | null | undefined) =>
    a === null || a === undefined || b === null || b === undefined ? null : a - b;
  /** Clock difference in minutes, folded into ±12h. */
  const clockDiff = (a: string | null | undefined, b: string | null | undefined) => {
    const x = toMin(a);
    const y = toMin(b);
    if (x === null || y === null) return null;
    let d = x - y;
    if (d > 720) d -= 1440;
    if (d < -720) d += 1440;
    return d;
  };

  const cmp = (items: Array<HeadlineComparison | null>): HeadlineComparison[] => items.filter((c): c is HeadlineComparison => c !== null);

  // Average arrival in words, relative to the shift start.
  let arrivalCtx: string;
  if (avgIn === null) {
    arrivalCtx = t("insights.people.m.noArrival", { defaultValue: "No arrivals recorded in this period" }) as string;
  } else if (shiftStart === null) {
    arrivalCtx = t("insights.people.m.firstSighting", { defaultValue: "First camera sighting of the day" }) as string;
  } else {
    let d = avgIn - shiftStart;
    if (d > 720) d -= 1440;
    if (d < -720) d += 1440;
    arrivalCtx =
      Math.abs(d) < 1
        ? (t("insights.people.m.atStart", { s: clockOf(shiftStart), defaultValue: `Right at shift start (${clockOf(shiftStart)})` }) as string)
        : d < 0
          ? (t("insights.people.m.beforeStart", { d: fmtMinutes(-d), s: clockOf(shiftStart), defaultValue: `${fmtMinutes(-d)} before shift start (${clockOf(shiftStart)})` }) as string)
          : (t("insights.people.m.afterStart", { d: fmtMinutes(d), s: clockOf(shiftStart), defaultValue: `${fmtMinutes(d)} after shift start (${clockOf(shiftStart)})` }) as string);
  }

  const attTone = k.attendance_pct >= 90 ? "success" : k.attendance_pct >= 75 ? "warning" : noSightings ? "neutral" : "danger";

  return (
    <HeadlineRow>
      <HeadlineMetric
        label={t("insights.people.m.attendance", { defaultValue: "Attendance" }) as string}
        value={Math.round(k.attendance_pct).toLocaleString()}
        suffix="%"
        meter={{
          pct: k.attendance_pct,
          tone: attTone,
          marker: dept?.attendance_pct ?? null,
          markerLabel: deptTitle(pct(dept?.attendance_pct)),
        }}
        context={t("insights.people.m.attendanceCtx", { p: k.present_days, wd: k.working_days, defaultValue: `Present ${k.present_days} of ${k.working_days} working days` }) as string}
        comparisons={cmp([
          prev ? { vs: vsPrev, delta: diff(k.attendance_pct, prev.attendance_pct), unit: "pts", better: "up", title: prevTitle } : null,
          dept ? { vs: vsDept, delta: diff(k.attendance_pct, dept.attendance_pct), unit: "pts", better: "up", title: deptTitle(pct(dept.attendance_pct)) } : null,
        ])}
      />
      <HeadlineMetric
        label={t("insights.people.m.punctuality", { defaultValue: "On time" }) as string}
        value={noSightings ? "—" : Math.round(k.punctuality_pct).toLocaleString()}
        {...(noSightings ? {} : { suffix: "%" })}
        context={
          noSightings
            ? (t("insights.people.m.punctualityNone", { defaultValue: "No present days to measure" }) as string)
            : (t("insights.people.m.punctualityCtx", { on: k.present_days - k.late_days, p: k.present_days, defaultValue: `${k.present_days - k.late_days} of ${k.present_days} present days on time` }) as string)
        }
        comparisons={
          noSightings
            ? []
            : cmp([
                prev ? { vs: vsPrev, delta: diff(k.punctuality_pct, prev.punctuality_pct), unit: "pts", better: "up", title: prevTitle } : null,
                dept ? { vs: vsDept, delta: diff(k.punctuality_pct, dept.punctuality_pct), unit: "pts", better: "up", title: deptTitle(pct(dept.punctuality_pct)) } : null,
              ])
        }
      />
      <HeadlineMetric
        label={t("insights.people.m.avgArrival", { defaultValue: "Average arrival" }) as string}
        value={hhmm(k.avg_in)}
        context={arrivalCtx}
        comparisons={
          avgIn === null
            ? []
            : cmp([
                prev ? { vs: vsPrev, delta: clockDiff(k.avg_in, prev.avg_in), unit: "clock", better: "down", title: prevTitle } : null,
                dept ? { vs: vsDept, delta: clockDiff(k.avg_in, dept.avg_in), unit: "clock", better: "down", title: deptTitle(hhmm(dept.avg_in)) } : null,
              ])
        }
      />
      <HeadlineMetric
        label={t("insights.people.m.avgHours", { defaultValue: "Time at work per day" }) as string}
        value={fmtHoursDur(k.avg_hours)}
        context={
          data.policy
            ? (t("insights.people.m.hoursCtx", { r: data.policy.required_hours, total: fmtHoursDur(k.total_hours), defaultValue: `${data.policy.required_hours}h required · ${fmtHoursDur(k.total_hours)} in total` }) as string)
            : (t("insights.people.m.hoursCtxNoPolicy", { total: fmtHoursDur(k.total_hours), defaultValue: `${fmtHoursDur(k.total_hours)} in total` }) as string)
        }
        comparisons={
          k.avg_hours === null
            ? []
            : cmp([
                prev ? { vs: vsPrev, delta: diff(k.avg_hours, prev.avg_hours), unit: "hours", better: "up", title: prevTitle } : null,
                dept ? { vs: vsDept, delta: diff(k.avg_hours, dept.avg_hours), unit: "hours", better: "up", title: deptTitle(fmtHoursDur(dept.avg_hours)) } : null,
              ])
        }
      />
    </HeadlineRow>
  );
}

// ---------------------------------------------------------------------------
// Highlights — plain-language sentences from the server's figures
// ---------------------------------------------------------------------------

function Highlights({ data }: { data: PersonV2 }) {
  const { t } = useTranslation();
  const weekdayName = useWeekdayName();
  const k = data.kpis;
  const h = data.highlights;
  const dept = data.compare?.department ?? null;
  const first = data.profile.full_name.split(/\s+/)[0] ?? data.profile.full_name;
  const items: Finding[] = [];
  const grace = data.policy?.grace_minutes ?? 0;

  if (k.present_days === 0 && k.working_days > 0) {
    items.push({
      id: "none",
      tone: "info",
      text: t("insights.people.hl.noSightings", {
        name: first,
        defaultValue: `No camera sightings for ${first} in this period. If they were at work, check their reference photos and the camera at their entrance.`,
      }) as string,
    });
  }
  if (h?.current_streak && h.current_streak.days >= 2 && k.present_days > 0) {
    items.push(
      h.current_streak.status === "present"
        ? { id: "streak", tone: "good", text: t("insights.people.hl.streakPresent", { n: h.current_streak.days, defaultValue: `Present ${h.current_streak.days} working days in a row, up to the end of the period.` }) as string }
        : { id: "streak", tone: "bad", text: t("insights.people.hl.streakAbsent", { n: h.current_streak.days, defaultValue: `Absent for the last ${h.current_streak.days} working days in a row.` }) as string },
    );
  }
  if (h && h.longest_present_streak >= 3 && !(h.current_streak?.status === "present" && h.current_streak.days === h.longest_present_streak)) {
    items.push({ id: "longest", tone: "good", text: t("insights.people.hl.longest", { n: h.longest_present_streak, defaultValue: `Longest run of attendance: ${h.longest_present_streak} working days.` }) as string });
  }
  if (h?.avg_minutes_vs_shift_start !== null && h?.avg_minutes_vs_shift_start !== undefined && k.present_days > 0) {
    const v = Math.round(h.avg_minutes_vs_shift_start);
    items.push(
      v <= 0
        ? { id: "arrive", tone: "good", text: t("insights.people.hl.early", { d: fmtMinutes(-v), defaultValue: `Usually arrives ${fmtMinutes(-v)} before the shift starts.` }) as string }
        : v <= grace
          ? { id: "arrive", tone: "good", text: t("insights.people.hl.laterGrace", { d: fmtMinutes(v), defaultValue: `Usually arrives ${fmtMinutes(v)} after the shift starts — within the grace period.` }) as string }
          : { id: "arrive", tone: "warn", text: t("insights.people.hl.later", { d: fmtMinutes(v), defaultValue: `Usually arrives ${fmtMinutes(v)} after the shift starts — past the grace period.` }) as string },
    );
  }
  if (k.late_days > 0) {
    const avg = h?.avg_late_minutes;
    items.push({
      id: "late",
      tone: k.late_days >= 3 ? "warn" : "neutral",
      text:
        avg !== null && avg !== undefined
          ? (t("insights.people.hl.lateAvg", { count: k.late_days, d: fmtMinutes(avg), defaultValue: `Late ${k.late_days} ${k.late_days === 1 ? "time" : "times"}, by ${fmtMinutes(avg)} on average.` }) as string)
          : (t("insights.people.hl.late", { count: k.late_days, defaultValue: `Late ${k.late_days} ${k.late_days === 1 ? "time" : "times"} in this period.` }) as string),
    });
  }
  if (h?.most_late_weekday && k.late_days >= 2) {
    const day = weekdayName(h.most_late_weekday);
    items.push({ id: "lateday", tone: "warn", text: t("insights.people.hl.lateDay", { day, defaultValue: `Late most often on ${day}.` }) as string });
  }
  if (k.late_days === 0 && k.present_days >= 3) {
    items.push({ id: "never", tone: "good", text: t("insights.people.hl.neverLate", { defaultValue: "Never late in this period." }) as string });
  }
  if (dept && dept.attendance_pct !== null && k.present_days > 0) {
    const d = Math.round(k.attendance_pct - dept.attendance_pct);
    if (Math.abs(d) >= 5) {
      items.push(
        d > 0
          ? { id: "dept", tone: "good", text: t("insights.people.hl.aboveDept", { n: d, dept: data.profile.department, defaultValue: `Attendance is ${d} points above the ${data.profile.department} average.` }) as string }
          : { id: "dept", tone: "warn", text: t("insights.people.hl.belowDept", { n: -d, dept: data.profile.department, defaultValue: `Attendance is ${-d} points below the ${data.profile.department} average.` }) as string },
      );
    }
  }
  if (k.leave_days > 0) {
    items.push({ id: "leave", tone: "info", text: t("insights.people.hl.leave", { count: k.leave_days, defaultValue: `${k.leave_days} ${k.leave_days === 1 ? "day" : "days"} of approved leave.` }) as string });
  }
  if (k.ot_hours > 0) {
    items.push({ id: "ot", tone: "info", text: t("insights.people.hl.ot", { d: fmtHoursDur(k.ot_hours), defaultValue: `${fmtHoursDur(k.ot_hours)} of overtime beyond the required hours.` }) as string });
  }

  return (
    <KeyFindings
      items={items}
      title={t("insights.people.hl.title", { defaultValue: "What stands out" }) as string}
      emptyText={t("insights.people.hl.none", { defaultValue: "Nothing unusual in this period." }) as string}
    />
  );
}

// ---------------------------------------------------------------------------
// Calendar heatmap
// ---------------------------------------------------------------------------

function CalendarHeatmap({ days, today, onOpen }: { days: PersonDay[]; today: string; onOpen: (iso: string) => void }) {
  const { t } = useTranslation();
  const statusLabel = useStatusLabel();
  const locale = useLocaleTag();
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const months = useMemo(() => {
    const out: string[] = [];
    for (const d of days) {
      const m = d.date.slice(0, 7);
      if (out[out.length - 1] !== m) out.push(m);
    }
    return out;
  }, [days]);
  const dows = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 4 + i).toLocaleDateString(locale, { weekday: "short" })),
    [locale],
  );

  return (
    <div className="card insp-panel">
      <div className="card-head">
        <div>
          <div className="card-title">{t("insights.people.calendarQ", { defaultValue: "Which days were they here?" }) as string}</div>
          <div className="card-sub">{t("insights.people.calendarSub", { defaultValue: "Status per day · click a day for detail" }) as string}</div>
        </div>
      </div>
      <div className="card-body">
        {days.length === 0 ? (
          <div className="insp-empty">{t("insights.people.noDays", { defaultValue: "No days in this range." }) as string}</div>
        ) : (
          <div
            className={`insp-months${months.length > 3 ? " is-compact" : ""}${months.length === 1 ? " is-single" : ""}`}
            style={{ gridTemplateColumns: `repeat(${Math.min(3, months.length)}, minmax(0, 1fr))` }}
          >
            {months.map((m) => {
              const first = parseIso(`${m}-01`);
              const lead = first.getDay();
              const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
              const inRange = days.filter((d) => d.date.startsWith(m)).map((d) => Number(d.date.slice(8)));
              const weekFrom = Math.floor((lead + Math.min(...inRange) - 1) / 7);
              const weekTo = Math.floor((lead + Math.max(...inRange) - 1) / 7);
              const shown = (dom: number) => {
                const w = Math.floor((lead + dom - 1) / 7);
                return w >= weekFrom && w <= weekTo;
              };
              const title = first.toLocaleDateString(locale, { month: "long", year: "numeric" });
              return (
                <div key={m}>
                  <div className="insp-month-title">{title}</div>
                  <div className="insp-cal" role="grid" aria-label={title}>
                    {dows.map((d) => (
                      <div key={d} className="insp-cal-dow">{d}</div>
                    ))}
                    {(weekFrom === 0 ? Array.from({ length: lead }) : []).map((_, i) => (
                      <div key={`l${i}`} className="insp-cal-cell is-out" aria-hidden />
                    ))}
                    {Array.from({ length: daysInMonth }).map((_, i) => {
                      const iso = `${m}-${String(i + 1).padStart(2, "0")}`;
                      if (!shown(i + 1)) return null;
                      const d = byDate.get(iso);
                      if (!d) {
                        return (
                          <div key={iso} className="insp-cal-cell is-blank" aria-hidden>
                            <span className="d">{i + 1}</span>
                          </div>
                        );
                      }
                      const future = iso > today;
                      const tone = toneOf(d.status);
                      const tn = tone !== "neutral" && tone !== "weekend" ? TONE[tone] : null;
                      const quiet = (d.status === "weekend" || d.status === "holiday") && !d.in_time;
                      const cls = [
                        "insp-cal-cell",
                        future ? "is-future" : "",
                        d.status === "weekend" && !d.in_time ? "is-off" : "",
                        d.status === "no_record" || d.status === "waiting" ? "is-norec" : "",
                        iso === today ? "is-today" : "",
                      ].filter(Boolean).join(" ");
                      const style = (tn && !future ? { "--c-soft": tn.soft, "--c-fg": tn.fg, "--c-dot": tn.dot } : {}) as CSSProperties;
                      const tip = [
                        parseIso(iso).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" }),
                        statusLabel(d.status),
                        d.in_time ? `${hhmm(d.in_time)} – ${hhmm(d.out_time)}` : "",
                        d.leave_name ?? "",
                      ].filter(Boolean).join(" · ");
                      return (
                        <button key={iso} type="button" className={cls} style={style} title={tip} aria-label={tip} disabled={future} onClick={() => onOpen(iso)}>
                          <span className="d">{i + 1}</span>
                          {!future && !quiet && d.in_time && <span className="m">{hhmm(d.in_time)}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="insp-legend" style={{ marginTop: 14 }}>
          {(["present", "late", "absent", "leave", "holiday"] as const).map((k) => (
            <span key={k}>
              <i style={{ background: TONE[k].soft, boxShadow: `inset 0 0 0 1px ${TONE[k].dot}` }} />
              {statusLabel(k)}
            </span>
          ))}
          <span>
            <i className="insp-legend-off" />
            {statusLabel("weekend")}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arrival-time chart: one dot per working day vs shift start + grace
// ---------------------------------------------------------------------------

function ArrivalChart({ data, days, onOpen }: { data: PersonV2; days: PersonDay[]; onOpen: (iso: string) => void }) {
  const { t } = useTranslation();
  const statusLabel = useStatusLabel();
  const locale = useLocaleTag();
  const [ref, width] = useWidth<HTMLDivElement>();
  const win = parseWindow(data.policy?.window);
  const shiftStart = win ? win[0] : null;
  const grace = data.policy?.grace_minutes ?? 0;
  const graceLine = shiftStart !== null ? shiftStart + grace : null;

  // Arrival minutes, unwrapped around the shift start for overnight shifts.
  const points = useMemo(
    () =>
      days.map((d) => {
        let m = toMin(d.in_time);
        if (m !== null && shiftStart !== null) {
          if (m - shiftStart > 720) m -= 1440;
          if (shiftStart - m > 720) m += 1440;
        }
        return { d, m };
      }),
    [days, shiftStart],
  );
  const arrivals = points.filter((p) => p.m !== null).map((p) => p.m as number);

  if (arrivals.length === 0) {
    return (
      <div className="card insp-panel">
        <div className="card-head">
          <div>
            <div className="card-title">{t("insights.people.arrivalQ", { defaultValue: "Are they arriving on time?" }) as string}</div>
            <div className="card-sub">{t("insights.people.arrivalSub", { defaultValue: "First camera sighting each working day against the shift start" }) as string}</div>
          </div>
        </div>
        <div className="card-body">
          <div className="insp-chart-empty">
            <Icon name="clock" size={18} />
            <span>{t("insights.people.arrivalNone", { defaultValue: "No arrivals were recorded in this period, so there is nothing to plot yet." }) as string}</span>
          </div>
        </div>
      </div>
    );
  }

  // Y axis (earlier at the top): covers the shift start, the grace line and
  // every arrival, padded to whole half-hours.
  let lo = Math.min(...arrivals, shiftStart ?? Infinity);
  let hi = Math.max(...arrivals, graceLine ?? -Infinity);
  lo = Math.floor((lo - 20) / 30) * 30;
  hi = Math.ceil((hi + 20) / 30) * 30;
  const span = Math.max(60, hi - lo);
  const H = 260;
  const padTop = 12;
  const padBottom = 44;
  const padStart = 48;
  const padEnd = 12;
  const W = Math.max(320, width);
  const plotW = W - padStart - padEnd;
  const plotH = H - padTop - padBottom;
  const n = Math.max(1, points.length);
  const step = plotW / n;
  const yOf = (m: number) => padTop + ((m - lo) / span) * plotH;
  const tickStep = span > 6 * 60 ? 120 : span > 3 * 60 ? 60 : 30;
  const ticks: number[] = [];
  for (let m = Math.ceil(lo / tickStep) * tickStep; m <= hi; m += tickStep) ticks.push(m);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 46))));
  const rtl = locale.startsWith("ar");
  // Gutter for the time labels sits on the inline-start side.
  const x0 = rtl ? padEnd : padStart;
  const x1 = rtl ? W - padStart : W - padEnd;
  const xPos = (i: number) => (rtl ? x1 - step * (i + 0.5) : x0 + step * (i + 0.5));
  const markY = padTop + plotH + 7;

  const onTime = points.filter((p) => p.m !== null && !(p.d.status === "late" || (p.d.late_minutes ?? 0) > 0)).length;
  const late = arrivals.length - onTime;

  const answer =
    late === 0
      ? (t("insights.people.arrivalAllOnTime", { n: onTime, defaultValue: `Yes — on time on all ${onTime} days with an arrival.` }) as string)
      : (t("insights.people.arrivalAnswer", { on: onTime, n: arrivals.length, late, defaultValue: `On time on ${onTime} of ${arrivals.length} days · late ${late}.` }) as string);

  return (
    <div className="card insp-panel">
      <div className="card-head">
        <div>
          <div className="card-title">
            <QuestionTitle question={t("insights.people.arrivalQ", { defaultValue: "Are they arriving on time?" }) as string} answer={answer} />
          </div>
          <div className="card-sub">
            {shiftStart !== null
              ? (t("insights.people.arrivalSubPolicy", {
                  s: clockOf(shiftStart),
                  g: clockOf(graceLine ?? shiftStart),
                  defaultValue: `First camera sighting each day · shift starts ${clockOf(shiftStart)}, late after ${clockOf(graceLine ?? shiftStart)}`,
                }) as string)
              : (t("insights.people.arrivalSub", { defaultValue: "First camera sighting each working day against the shift start" }) as string)}
          </div>
        </div>
        <div className="insp-legend">
          <span><i className="insp-dot-good" />{t("insights.people.onTimeN", { n: onTime, defaultValue: `On time (${onTime})` }) as string}</span>
          <span><i className="insp-dot-late" />{t("insights.people.lateN", { n: late, defaultValue: `Late (${late})` }) as string}</span>
          <span><i className="insp-dot-absent" />{t("insights.status.absent", { defaultValue: "Absent" }) as string}</span>
          <span><i className="insp-dot-leave" />{t("insights.status.leave", { defaultValue: "On leave" }) as string}</span>
        </div>
      </div>
      <div className="card-body">
        <div ref={ref} className="insp-arrival">
          {width > 0 && (
            <svg width={W} height={H} direction="ltr" role="img" aria-label={t("insights.people.arrivalQ", { defaultValue: "Are they arriving on time?" }) as string}>
              {/* Quiet gaps for weekends / holidays */}
              {points.map((p, i) =>
                p.d.status === "weekend" || p.d.status === "holiday" || p.d.is_weekend || p.d.is_holiday ? (
                  p.m === null ? (
                    <rect key={`g${p.d.date}`} x={xPos(i) - step / 2} y={padTop} width={step} height={plotH} className="insp-ac-off" />
                  ) : null
                ) : null,
              )}
              {/* Late zone below the grace line */}
              {graceLine !== null && yOf(graceLine) < padTop + plotH && (
                <rect x={x0} y={Math.max(padTop, yOf(graceLine))} width={plotW} height={padTop + plotH - Math.max(padTop, yOf(graceLine))} className="insp-ac-latezone" />
              )}
              {ticks.map((m) => (
                <g key={m}>
                  <line x1={x0} x2={x1} y1={yOf(m)} y2={yOf(m)} className="insp-ac-grid" />
                  <text x={rtl ? x1 + 8 : x0 - 8} y={yOf(m) + 4} textAnchor={rtl ? "start" : "end"} className="insp-ac-tick">
                    {clockOf(m)}
                  </text>
                </g>
              ))}
              {shiftStart !== null && (
                <g>
                  <line x1={x0} x2={x1} y1={yOf(shiftStart)} y2={yOf(shiftStart)} className="insp-ac-start" />
                </g>
              )}
              {graceLine !== null && grace > 0 && (
                <g>
                  <line x1={x0} x2={x1} y1={yOf(graceLine)} y2={yOf(graceLine)} className="insp-ac-grace" />
                </g>
              )}
              {/* X labels */}
              {points.map((p, i) =>
                i % labelEvery === 0 ? (
                  <text key={`x${p.d.date}`} x={xPos(i)} y={H - 6} textAnchor="middle" className="insp-ac-tick">
                    {parseIso(p.d.date).toLocaleDateString(locale, { day: "numeric", month: points.length > 10 ? undefined : "short" })}
                  </text>
                ) : null,
              )}
              {/* Points */}
              {points.map((p, i) => {
                const dateTxt = parseIso(p.d.date).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
                if (p.m !== null) {
                  const isLate = p.d.status === "late" || (p.d.late_minutes ?? 0) > 0;
                  const tip = [dateTxt, `${t("insights.people.arrived", { defaultValue: "Arrived" }) as string} ${hhmm(p.d.in_time)}`, isLate && p.d.late_minutes ? (t("insights.people.lateBy", { n: p.d.late_minutes, defaultValue: `late by ${p.d.late_minutes} min` }) as string) : statusLabel(p.d.status)].join(" · ");
                  return (
                    <g key={p.d.date} className="insp-ac-pt" onClick={() => onOpen(p.d.date)} role="button" tabIndex={0} aria-label={tip}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p.d.date); } }}>
                      <title>{tip}</title>
                      <circle cx={xPos(i)} cy={yOf(p.m)} r={Math.min(6, Math.max(3.5, step / 3))} className={isLate ? "is-late" : "is-good"} />
                    </g>
                  );
                }
                if (p.d.status === "absent" || p.d.status === "leave") {
                  const tip = [dateTxt, statusLabel(p.d.status), p.d.leave_name ?? ""].filter(Boolean).join(" · ");
                  return (
                    <g key={p.d.date} className="insp-ac-pt" onClick={() => onOpen(p.d.date)} role="button" tabIndex={0} aria-label={tip}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p.d.date); } }}>
                      <title>{tip}</title>
                      <rect x={xPos(i) - Math.min(5, step / 3)} y={markY} width={Math.min(10, (step / 3) * 2)} height={5} rx={2} className={p.d.status === "leave" ? "is-leave" : "is-absent"} />
                    </g>
                  );
                }
                return null;
              })}
              {/* Line labels on top of the dots (haloed) */}
              {shiftStart !== null && (
                <text x={rtl ? x0 + 4 : x1 - 4} y={yOf(shiftStart) - 6} textAnchor={rtl ? "start" : "end"} className="insp-ac-lbl">
                  {t("insights.people.shiftStartLbl", { s: clockOf(shiftStart), defaultValue: `Shift start ${clockOf(shiftStart)}` }) as string}
                </text>
              )}
              {graceLine !== null && grace > 0 && (
                <text x={rtl ? x0 + 4 : x1 - 4} y={yOf(graceLine) + 14} textAnchor={rtl ? "start" : "end"} className="insp-ac-lbl is-late">
                  {t("insights.people.graceLbl", { s: clockOf(graceLine), defaultValue: `Late after ${clockOf(graceLine)}` }) as string}
                </text>
              )}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily table with filter chips
// ---------------------------------------------------------------------------

function CropThumb({ eventId, label, onOpen }: { eventId: number | null; label: string; onOpen: (c: { id: number; label: string }) => void }) {
  const [failed, setFailed] = useState(false);
  if (eventId === null || failed) {
    return (
      <span className="insp-crop is-empty" aria-label={label} title={label}>
        <Icon name="user" size={12} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="insp-crop"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen({ id: eventId, label });
      }}
    >
      <img src={`/api/detection-events/${eventId}/crop`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </button>
  );
}

function CropLightbox({ crop, onClose }: { crop: { id: number; label: string }; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="insp-lightbox" role="dialog" aria-modal="true" aria-label={crop.label} onClick={onClose}>
      <div className="insp-lightbox-card" onClick={(e) => e.stopPropagation()}>
        <div className="insp-lightbox-head">
          <span>{crop.label}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close", { defaultValue: "Close" }) as string} autoFocus>
            <Icon name="x" size={14} />
          </button>
        </div>
        <img src={`/api/detection-events/${crop.id}/crop`} alt={crop.label} />
      </div>
    </div>
  );
}

type DayFilter = "all" | "late" | "absent" | "leave" | "ot";

function DailyTable({
  days,
  hiddenBeforeJoining,
  joiningDate,
  onOpen,
  onCrop,
}: {
  days: PersonDay[];
  hiddenBeforeJoining: number;
  joiningDate: string | null;
  onOpen: (iso: string) => void;
  onCrop: (c: { id: number; label: string }) => void;
}) {
  const { t } = useTranslation();
  const statusLabel = useStatusLabel();
  const locale = useLocaleTag();
  const [filter, setFilter] = useState<DayFilter>("all");
  const inLabel = t("insights.people.inPhoto", { defaultValue: "First sighting" }) as string;
  const outLabel = t("insights.people.outPhoto", { defaultValue: "Last sighting" }) as string;

  const match: Record<DayFilter, (d: PersonDay) => boolean> = {
    all: () => true,
    late: (d) => d.status === "late" || (d.late_minutes ?? 0) > 0,
    absent: (d) => d.status === "absent",
    leave: (d) => d.status === "leave",
    ot: (d) => d.ot_minutes > 0,
  };
  const counts = (Object.keys(match) as DayFilter[]).reduce(
    (acc, k) => ({ ...acc, [k]: days.filter(match[k]).length }),
    {} as Record<DayFilter, number>,
  );
  const rows = days.filter(match[filter]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // In "All days", runs of 3+ consecutive days with nothing to show (no
  // record / weekend / holiday without a sighting) collapse into one row.
  const isQuiet = (d: PersonDay) =>
    !d.in_time && (d.status === "no_record" || d.status === "waiting" || d.status === "weekend" || d.status === "holiday");
  type Block = { kind: "day"; d: PersonDay } | { kind: "run"; key: string; days: PersonDay[] };
  const blocks: Block[] = [];
  if (filter === "all") {
    let run: PersonDay[] = [];
    const flush = () => {
      if (run.length >= 3 && !expanded.has(run[0]!.date)) blocks.push({ kind: "run", key: run[0]!.date, days: run });
      else for (const d of run) blocks.push({ kind: "day", d });
      run = [];
    };
    for (const d of rows) {
      if (isQuiet(d)) run.push(d);
      else {
        flush();
        blocks.push({ kind: "day", d });
      }
    }
    flush();
  } else {
    for (const d of rows) blocks.push({ kind: "day", d });
  }
  const shortDate = (iso: string) => parseIso(iso).toLocaleDateString(locale, { day: "numeric", month: "short" });
  const chips: Array<[DayFilter, string]> = [
    ["all", t("insights.people.filter.all", { defaultValue: "All days" }) as string],
    ["late", t("insights.people.filter.late", { defaultValue: "Late" }) as string],
    ["absent", t("insights.people.filter.absent", { defaultValue: "Absent" }) as string],
    ["leave", t("insights.people.filter.leave", { defaultValue: "Leave" }) as string],
    ["ot", t("insights.people.filter.ot", { defaultValue: "Overtime" }) as string],
  ];
  const joinedTxt = joiningDate ? parseIso(joiningDate).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) : "";

  return (
    <div className="card insp-panel">
      <div className="card-head">
        <div>
          <div className="card-title">{t("insights.people.daily", { defaultValue: "Day by day" }) as string}</div>
          <div className="card-sub">
            {t("insights.people.dailySubV2", { defaultValue: "In / out = first and last camera sighting · click a row for the full day" }) as string}
            {hiddenBeforeJoining > 0 && (
              <>
                {" · "}
                {t("insights.people.beforeJoiningHidden", { n: hiddenBeforeJoining, d: joinedTxt, defaultValue: `${hiddenBeforeJoining} days before joining (${joinedTxt}) not shown` }) as string}
              </>
            )}
          </div>
        </div>
        <div className="insp-chips" role="group" aria-label={t("insights.people.filter.label", { defaultValue: "Show days" }) as string}>
          {chips.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`insp-fchip is-${k}${filter === k ? " is-active" : ""}`}
              aria-pressed={filter === k}
              disabled={k !== "all" && counts[k] === 0}
              onClick={() => setFilter(k)}
            >
              {label}
              <span className="insp-fchip-n">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="insp-empty">{t("insights.people.noDaysFilter", { defaultValue: "No days match this filter." }) as string}</div>
      ) : (
        <div className="insp-table-wrap">
          <table className="table insp-table">
            <thead>
              <tr>
                <th>{t("insights.people.col.date", { defaultValue: "Date" }) as string}</th>
                <th>{t("insights.people.col.status", { defaultValue: "Status" }) as string}</th>
                <th>{t("insights.people.col.in", { defaultValue: "In" }) as string}</th>
                <th>{t("insights.people.col.out", { defaultValue: "Out" }) as string}</th>
                <th className="insp-end">{t("insights.people.col.hours", { defaultValue: "Time at work" }) as string}</th>
                <th className="insp-end">{t("insights.people.col.lateBy", { defaultValue: "Late by" }) as string}</th>
                <th className="insp-end">{t("insights.people.col.ot", { defaultValue: "Overtime" }) as string}</th>
                <th>{t("insights.people.col.photos", { defaultValue: "In · Out photo" }) as string}</th>
                <th>{t("insights.people.col.camera", { defaultValue: "Camera" }) as string}</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => {
                if (b.kind === "run") {
                  const noRec = b.days.filter((d) => d.status === "no_record" || d.status === "waiting").length;
                  const off = b.days.length - noRec;
                  const parts = [
                    noRec ? (t("insights.people.run.noRecord", { count: noRec, defaultValue: `${noRec} no record` }) as string) : "",
                    off ? (t("insights.people.run.off", { count: off, defaultValue: `${off} weekend / holiday` }) as string) : "",
                  ].filter(Boolean).join(" · ");
                  return (
                    <tr key={`run-${b.key}`} className="insp-run">
                      <td colSpan={9}>
                        <button
                          type="button"
                          className="insp-run-btn"
                          onClick={() => setExpanded((prev) => new Set(prev).add(b.key))}
                          aria-label={t("insights.people.run.expand", { defaultValue: "Show these days" }) as string}
                        >
                          <Icon name="chevronDown" size={12} />
                          <b className="insp-num">
                            {shortDate(b.days[0]!.date)} – {shortDate(b.days[b.days.length - 1]!.date)}
                          </b>
                          <span>
                            {t("insights.people.run.summary", { count: b.days.length, defaultValue: `${b.days.length} days with nothing recorded` }) as string}
                          </span>
                          <span className="insp-dim">({parts})</span>
                        </button>
                      </td>
                    </tr>
                  );
                }
                const d = b.d;
                const tone = toneOf(d.status);
                const off = !d.in_time && (d.status === "weekend" || d.status === "holiday" || d.status === "no_record" || d.status === "waiting");
                const rowCls = off ? "is-off" : d.status === "leave" ? "is-leave" : "";
                const flags = flagsOf(d);
                const extra: string[] = [];
                if (flags.includes("early")) extra.push(t("insights.people.flag.early", { defaultValue: "Early out" }) as string);
                if (flags.includes("short")) extra.push(t("insights.people.flag.short", { defaultValue: "Short hours" }) as string);
                const style = (tone !== "neutral" ? { "--row-dot": TONE[tone].dot } : {}) as CSSProperties;
                const dateTxt = parseIso(d.date).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
                const isLate = (d.late_minutes ?? 0) > 0;
                return (
                  <tr
                    key={d.date}
                    className={rowCls}
                    style={style}
                    tabIndex={0}
                    onClick={() => onOpen(d.date)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpen(d.date);
                      }
                    }}
                    aria-label={`${dateTxt} · ${statusLabel(d.status)}`}
                  >
                    <td className="insp-num">{dateTxt}</td>
                    <td>
                      {off && d.status !== "holiday" ? (
                        <span className="insp-dim">{statusLabel(d.status)}</span>
                      ) : (
                        <StatusPill status={d.status} />
                      )}
                      {d.leave_name && d.status === "leave" && <span className="insp-sub-note">{d.leave_name}</span>}
                      {d.in_time && (d.is_weekend || d.is_holiday) && (
                        <span className="insp-sub-note">
                          {d.is_holiday
                            ? (t("insights.people.onHoliday", { defaultValue: "on a holiday" }) as string)
                            : (t("insights.people.onWeekend", { defaultValue: "on a weekend" }) as string)}
                        </span>
                      )}
                      {extra.map((x) => (
                        <span key={x} className="insp-flag is-early">{x}</span>
                      ))}
                    </td>
                    <td className={`insp-num${d.in_time ? "" : " insp-dim"}${isLate ? " insp-late" : ""}`}>{hhmm(d.in_time)}</td>
                    <td className={`insp-num${d.out_time ? "" : " insp-dim"}`}>{hhmm(d.out_time)}</td>
                    <td className={`insp-num insp-end${d.hours === null ? " insp-dim" : ""}`}>{fmtHoursDur(d.hours)}</td>
                    <td className={`insp-num insp-end${isLate ? " insp-late" : " insp-dim"}`}>{isLate ? fmtMinutes(d.late_minutes) : "—"}</td>
                    <td className={`insp-num insp-end${d.ot_minutes > 0 ? " insp-ot" : " insp-dim"}`}>{d.ot_minutes > 0 ? fmtMinutes(d.ot_minutes) : "—"}</td>
                    <td>
                      {d.first_event_id === null && d.last_event_id === null ? (
                        <span className="insp-dim">—</span>
                      ) : (
                        <span className="insp-crops">
                          <CropThumb eventId={d.first_event_id} label={`${inLabel} · ${d.date} ${hhmm(d.in_time)}`} onOpen={onCrop} />
                          <CropThumb eventId={d.last_event_id !== d.first_event_id ? d.last_event_id : null} label={`${outLabel} · ${d.date} ${hhmm(d.out_time)}`} onOpen={onCrop} />
                        </span>
                      )}
                    </td>
                    <td className="text-sm insp-cam">{d.camera ?? <span className="insp-dim">—</span>}</td>
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

// ---------------------------------------------------------------------------
// Requests in period
// ---------------------------------------------------------------------------

function RequestsPanel({ requests }: { requests: InsightsEmployee["requests"] }) {
  const { t } = useTranslation();
  const locale = useLocaleTag();
  const dayLabel = (iso: string) => parseIso(iso).toLocaleDateString(locale, { day: "numeric", month: "short" });
  const reqTone = (s: string): string => (/reject|cancel/.test(s) ? "pill-danger" : /approved/.test(s) ? "pill-success" : "pill-warning");
  return (
    <div className="card insp-panel">
      <div className="card-head">
        <div>
          <div className="card-title">{t("insights.people.requests", { defaultValue: "Requests in period" }) as string}</div>
          <div className="card-sub">{t("insights.people.requestsSub", { defaultValue: "Exceptions and leave raised by the employee" }) as string}</div>
        </div>
        <span className="pill pill-neutral">{requests.length}</span>
      </div>
      {requests.length === 0 ? (
        <div className="insp-empty">{t("insights.people.noRequests", { defaultValue: "No requests raised in this period." }) as string}</div>
      ) : (
        <div className="insp-req">
          {requests.map((r) => (
            <div key={r.id} className="insp-req-row">
              <span className="insp-num">
                {dayLabel(r.start)}
                {r.end && r.end !== r.start ? ` → ${dayLabel(r.end)}` : ""}
              </span>
              <span style={{ fontWeight: 600 }}>
                {t(`insights.people.requestType.${r.type}`, { defaultValue: r.type === "leave" ? "Leave" : r.type === "exception" ? "Exception" : r.type }) as string}
              </span>
              <span className="insp-req-reason" title={r.reason}>{r.reason || "—"}</span>
              <span className={`pill ${reqTone(r.status)}`}>
                {t(`insights.people.requestStatus.${r.status}`, { defaultValue: r.status.replace(/_/g, " ") }) as string}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
