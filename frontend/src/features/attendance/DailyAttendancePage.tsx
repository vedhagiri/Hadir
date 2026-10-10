// Admin / HR / Manager Daily Attendance page.
// Layout matches docs/scripts/issues-screenshots/05-Daily_attendance_page.png:
// page-header with regenerate + download buttons, a filter row with a
// segmented scope picker, five stat cards, then a card-wrapped table
// with avatars + status pills.
//
// Backend role-scoping is the source of truth — Manager sees the
// union of department membership + manager_assignments (handled in
// the router, not here).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnomalyInfoBanner } from "../../components/AnomalyNote";

import { useMe } from "../../auth/AuthProvider";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { ModalShell } from "../../components/DrawerShell";
import { PdfOptionsModal } from "../../components/PdfOptionsModal";
import { useConfidentialDownload } from "../../components/useConfidentialDownload";
import { primaryRole } from "../../types";
import { useTenantDateTime } from "../../util/datetime";
import { useDepartments } from "../departments/hooks";
import { useEmployeeList, useMyTeamList } from "../employees/hooks";
import { AttendanceDrawer } from "./AttendanceDrawer";
import {
  useAttendance,
  useRegenerateAttendance,
  useSendTodayAttendanceEmails,
} from "./hooks";
import type { SendTodayResult } from "./hooks";
import { formatMinutes } from "./timeFormat";
import type { AttendanceItem } from "./types";
import { SkeletonCards, SkeletonRows } from "../../components/Skeleton";
import {
  EmptyPanel,
  FilterSelect,
  ResetButton,
  SearchField,
  StatCard,
  StatGrid,
  Toolbar,
  pct,
} from "../../components/ListPageUi";
import { Icon } from "../../shell/Icon";
import { ATT_ICON, DotPill, FieldGroup, StrokeIcon, fieldDateStyle } from "./attendanceUi";

type ScopeMode = "company" | "department" | "team" | "individual";

// The status buckets shown as stat cards (and now click-to-filter chips).
type DayStatus = "present" | "late" | "absent" | "onLeave" | "pending" | "offDay";

// Single source of truth for a row's status bucket. Used by BOTH the
// stat-card counts and the click-to-filter logic, so a card's number is
// always exactly the number of rows clicking it filters to. The order
// mirrors the StatusPill priority: leave > off-day > pending > absent >
// late > present.
function classifyStatus(it: AttendanceItem): DayStatus | "other" {
  // Leave is the highest-priority status. The engine clears ``absent``
  // to false on a leave day (absent = no-leave AND not-holiday/weekend),
  // so an "On Leave" row is leave_type_id set + absent=false — gating on
  // ``absent`` here would never match and the row would fall through.
  if (it.leave_type_id !== null) return "onLeave";
  if (
    !it.in_time &&
    it.leave_type_id === null &&
    (it.is_holiday || it.is_weekend)
  )
    return "offDay";
  if (
    it.pending &&
    it.leave_type_id === null &&
    !it.is_holiday &&
    !it.is_weekend
  )
    return "pending";
  if (
    !it.in_time &&
    it.leave_type_id === null &&
    !it.pending &&
    !it.is_holiday &&
    !it.is_weekend
  )
    return "absent";
  if (it.in_time && it.late) return "late";
  if (it.in_time && !it.late) return "present";
  return "other";
}

// Maps a status bucket to the existing stat-card label key, so the
// filter chip reuses the same translated word as the card.
const STAT_LABEL_KEY: Record<DayStatus, string> = {
  present: "dailyAttendance.stat.present",
  late: "dailyAttendance.stat.late",
  absent: "dailyAttendance.stat.absent",
  onLeave: "dailyAttendance.stat.onLeave",
  pending: "dailyAttendance.stat.waiting",
  offDay: "dailyAttendance.stat.offDay",
};

export function DailyAttendancePage() {
  const { t } = useTranslation();
  const me = useMe();
  const role = me.data ? primaryRole(me.data.roles) : "Employee";
  const isAdminLike = role === "Admin" || role === "HR";
  const isManager = role === "Manager";
  const fmtTime = useShortTime();

  const [date, setDate] = useState<string>(todayIso());
  // Manager default lands on "team" — that's their natural scope (the
  // backend auto-narrows /api/attendance to their team-rule set when
  // no department/employee filter is supplied).
  const [scopeMode, setScopeMode] = useState<ScopeMode>(
    isManager ? "team" : "company",
  );
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [drawerItem, setDrawerItem] = useState<AttendanceItem | null>(null);
  const [regenInfo, setRegenInfo] = useState<string | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  // Manual email-send modal (0080). Button hidden by default;
  // revealed by clicking the ✉ icon toggle or Shift+A. Admin/HR only.
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [sendBtnVisible, setSendBtnVisible] = useState(false);
  const [sendResult, setSendResult] = useState<SendTodayResult | null>(null);
  const sendEmails = useSendTodayAttendanceEmails();

  useEffect(() => {
    if (!isAdminLike) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.key !== "A" && e.key !== "a")) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      setSendBtnVisible(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isAdminLike]);

  // Client-side quick-find — matches the displayed rows in the table
  // (stats below still reflect the full scope so the operator sees
  // accurate totals while narrowing the visible list).
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Click-to-filter on the stat cards. null = show everything (the
  // "In scope" card). Clicking a status card narrows the table to that
  // status; clicking the active card again clears it. The card counts
  // always reflect the full scope so the operator keeps the totals.
  const [statusFilter, setStatusFilter] = useState<DayStatus | null>(null);
  const toggleStatus = (s: DayStatus) =>
    setStatusFilter((cur) => (cur === s ? null : s));

  const filtersActive =
    !!searchQuery ||
    statusFilter !== null ||
    (scopeMode === "department" && departmentId !== null) ||
    (scopeMode === "individual" && employeeId !== null);
  const resetFilters = () => {
    setSearchQuery("");
    setStatusFilter(null);
    setDepartmentId(null);
    setEmployeeId(null);
  };

  // Sticky-stack measurement. The page header, filters and stat tiles
  // scroll away normally (pinning them ate most of a laptop screen);
  // only the table's own chrome stacks under the topbar, each layer
  // with ``top`` = sum of the heights above it, so there's no seam and
  // no z-index overlap:
  //
  //   ┌──────────────────────────────┐  ← cardHeadRef  (inside card)
  //   │ "Attendance for {date}" head │     top: 0
  //   ├──────────────────────────────┤  ← anomalyRef   (inside card)
  //   │ anomaly info banner          │     top: cardHeadH
  //   ├──────────────────────────────┤  ← <th>          (inside card)
  //   │ EMPLOYEE  DEPT  STATUS …     │     top: cardHeadH + anomalyH
  //   ├──────────────────────────────┤
  //   │ scrolling tbody rows         │
  //
  // ``useLayoutEffect`` so the heights are set before the first paint —
  // no first-frame flash where the thead briefly overlaps the controls.
  // ``getBoundingClientRect().height`` (not offsetHeight) + Math.round
  // so any sub-pixel jitter from inherited transforms doesn't oscillate
  // the offsets every frame.
  const cardHeadRef = useRef<HTMLDivElement | null>(null);
  const anomalyRef = useRef<HTMLDivElement | null>(null);
  const [cardHeadH, setCardHeadH] = useState(0);
  const [anomalyH, setAnomalyH] = useState(0);
  useLayoutEffect(() => {
    const measure = (
      el: HTMLElement | null,
      setH: (n: number) => void,
    ): ResizeObserver | null => {
      if (!el) return null;
      const update = () =>
        // Math.ceil (not Math.round) — rounding *down* on a fractional
        // height leaves a 1-px slit between this sticky region and the
        // next, through which scrolling rows bleed during fast scroll.
        // Ceiling guarantees the next layer pins at-or-below this one's
        // bottom edge.
        setH(Math.ceil(el.getBoundingClientRect().height));
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return ro;
    };
    const obs = [
      measure(cardHeadRef.current, setCardHeadH),
      measure(anomalyRef.current, setAnomalyH),
    ];
    return () => {
      for (const ro of obs) ro?.disconnect();
    };
  }, []);
  const theadTop = cardHeadH + anomalyH;

  // Every report download is gated through the confidentiality modal.
  const { gate: gateDownload, modal: confidentialModal } =
    useConfidentialDownload();
  const reportName = t("dailyAttendance.reportName", { date });
  const requestXlsx = () =>
    gateDownload({
      format: "xlsx",
      reportName,
      action: () => downloadReport("xlsx"),
    });
  const requestPdf = () =>
    gateDownload({
      format: "pdf",
      reportName,
      // Warning first, then PdfOptionsModal owns the rest of the flow.
      action: () => setPdfModalOpen(true),
    });

  // Wire the active scope to backend filters. For Manager + "Team",
  // we pass nothing — the backend's /api/attendance handler already
  // auto-narrows to the Manager's team via ``manager_team_employee_ids``
  // when no department/employee filter is supplied.
  const filterDeptId = scopeMode === "department" ? departmentId : null;
  const filterEmpId = scopeMode === "individual" ? employeeId : null;

  const list = useAttendance(date, filterDeptId, filterEmpId);
  const departmentsQuery = useDepartments();
  // Admin/HR get the full tenant; Manager pulls from /my-team so the
  // Individual picker matches the same set the attendance backend
  // auto-narrows to. The two hooks are mutually exclusive — enable
  // only the one that matches the caller's role.
  const adminEmployeesQuery = useEmployeeList(
    {
      q: "",
      department_id: null,
      include_inactive: false,
      page: 1,
      page_size: 200,
    },
    { enabled: !isManager },
  );
  const teamEmployeesQuery = useMyTeamList(isManager, { page_size: 200 });
  const employeesQuery = isManager ? teamEmployeesQuery : adminEmployeesQuery;
  const regenerate = useRegenerateAttendance();

  const stats = useMemo(() => {
    const items = list.data?.items ?? [];
    // One pass through the shared classifier so the counts can never
    // drift from the click-to-filter result.
    const c = { present: 0, late: 0, absent: 0, onLeave: 0, pending: 0, offDay: 0 };
    for (const it of items) {
      const s = classifyStatus(it);
      if (s !== "other") c[s] += 1;
    }
    return { total: items.length, ...c };
  }, [list.data]);

  // The in-scope card's subline surfaces the buckets that don't get a
  // card of their own (off day / waiting) so no count is hidden.
  const inScopeSub = (() => {
    const parts: string[] = [];
    if (stats.offDay > 0)
      parts.push(t("dailyAttendance.statSub.offDay", { defaultValue: "{{count}} off day", count: stats.offDay }));
    if (stats.pending > 0)
      parts.push(t("dailyAttendance.statSub.waiting", { defaultValue: "{{count}} waiting", count: stats.pending }));
    return parts.length
      ? parts.join(" · ")
      : t("dailyAttendance.statSub.inScope", { defaultValue: "In this view" });
  })();

  // Apply the status-card filter + live search to the rendered rows
  // only — stats stay on the unfiltered list so the "in scope" totals
  // remain accurate while the visible list is narrowed.
  const filteredItems = useMemo(() => {
    let items = list.data?.items ?? [];
    if (statusFilter) {
      items = items.filter((it) => classifyStatus(it) === statusFilter);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      items = items.filter(
        (it) =>
          it.full_name.toLowerCase().includes(q) ||
          it.employee_code.toLowerCase().includes(q),
      );
    }
    return items;
  }, [list.data, searchQuery, statusFilter]);

  // Five render states (brief addendum): loading → skeleton; error →
  // danger panel + retry; no records for the date → stats + table hidden,
  // accent panel with the regenerate action; records but no filter match
  // → stats + toolbar stay, neutral "no results" panel; otherwise rows.
  const hasRecords = (list.data?.items.length ?? 0) > 0;
  const showEmpty =
    !!list.data && !list.isLoading && filteredItems.length === 0;

  const onRegenerate = () => {
    setRegenInfo(null);
    regenerate.mutate(date, {
      onSuccess: (resp) => {
        setRegenInfo(
          t("dailyAttendance.regenSuccess", {
            count: resp.rows_upserted,
            date: resp.date,
          }),
        );
      },
      onError: (err) => {
        setRegenInfo(
          t("dailyAttendance.regenFailed", { message: (err as Error).message }),
        );
      },
    });
  };

  const downloadReport = async (
    format: "xlsx" | "pdf",
    pdfOpts?: { includeEmployeePhotos: boolean },
  ) => {
    const path =
      format === "pdf"
        ? "/api/reports/attendance.pdf"
        : "/api/reports/attendance.xlsx";
    const body: Record<string, unknown> = { start: date, end: date };
    if (filterDeptId !== null) body.department_id = filterDeptId;
    if (filterEmpId !== null) body.employee_id = filterEmpId;
    if (format === "pdf" && pdfOpts) {
      body.include_employee_photos = pdfOpts.includeEmployeePhotos;
    }
    const resp = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      setRegenInfo(t("dailyAttendance.downloadFailed", { status: resp.status }));
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance_${date}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handlePdfConfirm = async (includePhotos: boolean) => {
    setPdfBusy(true);
    try {
      await downloadReport("pdf", { includeEmployeePhotos: includePhotos });
    } finally {
      setPdfBusy(false);
      setPdfModalOpen(false);
    }
  };

  return (
    <>
      {/* Page header, action buttons, filter row and stat tiles —
          scroll with the page; only the table chrome below pins. */}
      <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("dailyAttendance.title")}</h1>
          <p className="page-sub">
            {t("dailyAttendance.subtitle")}
          </p>
        </div>
        <div className="page-actions">
          {isAdminLike && sendBtnVisible && (
            <button
              className="btn"
              onClick={() => setSendModalOpen(true)}
              title={t("dailyAttendance.sendEmailsTooltip")}
            >
              <Icon name="mail" size={13} />
              {t("dailyAttendance.sendEmails")}
            </button>
          )}
          <button
            className="btn"
            onClick={onRegenerate}
            disabled={regenerate.isPending || !isAdminLike}
            title={
              isAdminLike
                ? t("dailyAttendance.regenTooltipAllowed")
                : t("dailyAttendance.regenTooltipDenied")
            }
          >
            <Icon name="refresh" size={13} />
            {regenerate.isPending
              ? t("dailyAttendance.regenerating")
              : t("dailyAttendance.regenerate")}
          </button>
          <button
            className="btn btn-primary"
            onClick={requestXlsx}
            disabled={!list.data}
          >
            <Icon name="download" size={13} />
            {t("dailyAttendance.downloadXlsx")}
          </button>
        </div>
      </div>

      {regenInfo && (
        <div className="at-notice tone-info" role="status">
          <span className="at-notice-text">{regenInfo}</span>
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


      {/* Summary — counts come from the rows already loaded for the
          scope; each card doubles as the status filter. */}
      {list.isLoading ? (
        <div className="mg-stat-grid">
          <SkeletonCards count={5} minWidth={200} />
        </div>
      ) : hasRecords ? (
        <StatGrid>
          <StatCard
            tone="info"
            icon={ATT_ICON.people}
            label={t("dailyAttendance.stat.inScope")}
            value={stats.total}
            sub={inScopeSub}
            active={statusFilter === null}
            onClick={() => setStatusFilter(null)}
          />
          <StatCard
            tone="success"
            icon={ATT_ICON.present}
            label={t("dailyAttendance.stat.present")}
            value={stats.present}
            sub={`${pct(stats.present, stats.total)}%`}
            active={statusFilter === "present"}
            onClick={() => toggleStatus("present")}
          />
          <StatCard
            tone="warning"
            icon={ATT_ICON.late}
            label={t("dailyAttendance.stat.late")}
            value={stats.late}
            sub={`${pct(stats.late, stats.total)}%`}
            active={statusFilter === "late"}
            onClick={() => toggleStatus("late")}
          />
          <StatCard
            tone="danger"
            icon={ATT_ICON.absent}
            label={t("dailyAttendance.stat.absent")}
            value={stats.absent}
            sub={`${pct(stats.absent, stats.total)}%`}
            active={statusFilter === "absent"}
            onClick={() => toggleStatus("absent")}
          />
          <StatCard
            tone="neutral"
            icon={ATT_ICON.leave}
            label={t("dailyAttendance.stat.onLeave")}
            value={stats.onLeave}
            sub={`${pct(stats.onLeave, stats.total)}%`}
            active={statusFilter === "onLeave"}
            onClick={() => toggleStatus("onLeave")}
          />
        </StatGrid>
      ) : null}

      {/* Filter toolbar */}
      <Toolbar>
        <FieldGroup label={t("dailyAttendance.date")}>
          <DatePicker
            value={date}
            onChange={setDate}
            max={todayIso()}
            ariaLabel={t("dailyAttendance.dateAria")}
            triggerStyle={fieldDateStyle}
          />
        </FieldGroup>

        {/* Live search — name or employee code. Filters the rendered
            rows only; stats above stay on the full scope. */}
        <SearchField
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("dailyAttendance.searchPlaceholder")}
          clearLabel={t("dailyAttendance.clearSearchAria")}
        />

        <div className="seg" role="tablist" aria-label={t("dailyAttendance.scopeAria")}>
          <SegBtn
            active={scopeMode === "company"}
            onClick={() => setScopeMode("company")}
            icon="◳"
          >
            {t("dailyAttendance.scope.company")}
          </SegBtn>
          <SegBtn
            active={scopeMode === "department"}
            onClick={() => setScopeMode("department")}
            icon="▦"
          >
            {t("dailyAttendance.scope.department")}
          </SegBtn>
          <SegBtn
            active={scopeMode === "team"}
            onClick={() => setScopeMode("team")}
            icon="◇"
          >
            {t("dailyAttendance.scope.team")}
          </SegBtn>
          <SegBtn
            active={scopeMode === "individual"}
            onClick={() => setScopeMode("individual")}
            icon="◯"
          >
            {t("dailyAttendance.scope.individual")}
          </SegBtn>
        </div>

        {scopeMode === "department" && isAdminLike && (
          <FilterSelect
            label={t("dailyAttendance.filter.department", { defaultValue: "Department" })}
            value={departmentId === null ? "" : String(departmentId)}
            onChange={(v) => setDepartmentId(v === "" ? null : Number(v))}
            options={[
              ["", t("dailyAttendance.allDepartments")],
              ...(departmentsQuery.data?.items ?? []).map(
                (d) => [String(d.id), d.name] as [string, string],
              ),
            ]}
          />
        )}

        {scopeMode === "individual" && (
          <FilterSelect
            label={t("dailyAttendance.filter.employee", { defaultValue: "Employee" })}
            value={employeeId === null ? "" : String(employeeId)}
            onChange={(v) => setEmployeeId(v === "" ? null : Number(v))}
            options={[
              ["", t("dailyAttendance.selectEmployee")],
              ...(employeesQuery.data?.items ?? []).map(
                (emp) =>
                  [String(emp.id), `${emp.full_name} · ${emp.employee_code}`] as [string, string],
              ),
            ]}
          />
        )}

        <FilterSelect
          label={t("dailyAttendance.filter.status", { defaultValue: "Status" })}
          value={statusFilter ?? ""}
          onChange={(v) => setStatusFilter(v === "" ? null : (v as DayStatus))}
          options={[
            ["", t("dailyAttendance.filter.allStatus", { defaultValue: "All status" })],
            ["present", t(STAT_LABEL_KEY.present)],
            ["late", t(STAT_LABEL_KEY.late)],
            ["absent", t(STAT_LABEL_KEY.absent)],
            ["onLeave", t(STAT_LABEL_KEY.onLeave)],
            ["offDay", t(STAT_LABEL_KEY.offDay)],
            ["pending", t(STAT_LABEL_KEY.pending)],
          ]}
        />

        {scopeMode === "team" && isManager && (
          <span
            className="text-xs text-dim"
            title={t("dailyAttendance.teamHintManagerTitle")}
          >
            {t("dailyAttendance.teamHintManager")}
          </span>
        )}
        {scopeMode === "team" && !isManager && (
          <span
            className="text-xs text-dim"
            title={t("dailyAttendance.teamHintOtherTitle")}
          >
            {t("dailyAttendance.teamHintOther")}
          </span>
        )}

        <ResetButton
          active={filtersActive}
          label={t("dailyAttendance.filter.reset", { defaultValue: "Reset" })}
          onClick={resetFilters}
        />
      </Toolbar>

      </div>{/* /top sticky wrapper — page-header + filter + stats end here */}

      {/* Error → danger panel + retry (replaces the card entirely). */}
      {list.isError && !list.isLoading ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
            title={t("dailyAttendance.error.title", { defaultValue: "Couldn't load attendance" })}
            body={
              (list.error instanceof Error && list.error.message) ||
              t("dailyAttendance.loadFailed")
            }
            actions={
              <button type="button" className="btn" onClick={() => void list.refetch()}>
                <Icon name="refresh" size={12} />
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : !list.isLoading && list.data && !hasRecords ? (
        /* No records at all for this date → stats + table hidden. */
        <div className="card">
          <DailyEmptyState
            hasRows={false}
            searchQuery={searchQuery}
            statusLabel={null}
            onClear={resetFilters}
            onRegenerate={isAdminLike ? onRegenerate : null}
            regenerating={regenerate.isPending}
          />
        </div>
      ) : (
      /* Single table card. Inside it, three child regions each use
          position: sticky with a stacked ``top`` offset:
            1. card-head  → pins below the top-sticky wrapper
            2. anomaly    → pins below card-head
            3. each <th>  → pins below anomaly
          No card-splitting, no visible seam, no z-index overlap. */
      <div className="card">
        <div
          ref={cardHeadRef}
          className="card-head at-sticky-head"
          style={{ top: 0 }}
        >
          <div>
            <h3 className="card-title">
              {t("dailyAttendance.cardTitle", { date: list.data?.date ?? date })}
              {searchQuery && (
                <span className="at-title-note">
                  · {t("dailyAttendance.matchFor", { count: filteredItems.length, query: searchQuery })}
                </span>
              )}
              {statusFilter && (
                <span className="at-title-note">
                  · {t("dailyAttendance.statusFilter.showing", {
                    label: t(STAT_LABEL_KEY[statusFilter]),
                    count: filteredItems.length,
                  })}
                  <button
                    type="button"
                    onClick={() => setStatusFilter(null)}
                    aria-label={t("dailyAttendance.statusFilter.clearAria")}
                    className="at-link-x"
                  >
                    ×
                  </button>
                </span>
              )}
            </h3>
          </div>
          <div className="at-card-head-actions">
            <button
              className="btn btn-sm"
              onClick={requestPdf}
              disabled={!list.data || pdfBusy}
            >
              <Icon name="fileText" size={12} />
              {t("dailyAttendance.pdf")}
            </button>
            <button
              className="btn btn-sm"
              onClick={requestXlsx}
              disabled={!list.data}
            >
              <Icon name="download" size={12} />
              {t("dailyAttendance.xlsx")}
            </button>
          </div>
        </div>
        <div
          ref={anomalyRef}
          className="at-sticky-note"
          style={{ top: cardHeadH }}
        >
          <AnomalyInfoBanner message={t("dailyAttendance.anomalyNote")} />
        </div>

        {showEmpty ? (
          /* Records exist but search / status filter matches nothing. */
          <DailyEmptyState
            hasRows
            searchQuery={searchQuery}
            statusLabel={statusFilter ? t(STAT_LABEL_KEY[statusFilter]) : null}
            onClear={resetFilters}
            onRegenerate={null}
            regenerating={false}
          />
        ) : (
        <div className="at-scroll-x">
        <table className="table">
          <thead>
            <tr>
              {/* Per-cell ``position: sticky`` (not on <thead>) — the
                  design CSS uses ``border-collapse: collapse`` which
                  breaks sticky on <thead> in some browsers but works
                  reliably when applied per <th>. ``zIndex`` is below
                  the card-head + anomaly so a long header doesn't
                  overlap them on the way out. */}
              {([
                "employee", "department", "status",
                "in", "out", "hours", "ot", "flags",
              ] as const).map((key) => (
                <th key={key} className="at-sticky-th" style={{ top: theadTop }}>
                  {t(`dailyAttendance.col.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <SkeletonRows cols={8} />
            )}
            {filteredItems.map((it) => (
              <tr
                key={`${it.employee_id}-${it.date}`}
                onClick={() => setDrawerItem(it)}
                className="at-row-clickable"
              >
                <td>
                  <div className="at-person">
                    <Avatar name={it.full_name} />
                    <div>
                      <div
                        className={`at-person-name${it.employee_status === "inactive" ? " is-inactive" : ""}`}
                      >
                        {it.full_name}
                        {it.employee_status === "inactive" && (
                          <span className="pill pill-neutral">
                            {t("dailyAttendance.archived")}
                          </span>
                        )}
                      </div>
                      <div className="mono text-xs text-dim at-nowrap">
                        {it.employee_code}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="text-sm">{it.department.name}</td>
                <td className="at-nowrap">
                  <StatusPill item={it} />
                </td>
                <td className="mono text-sm">{fmtTime(it.in_time)}</td>
                <td className="mono text-sm">{fmtTime(it.out_time)}</td>
                <td className="mono text-sm">{formatMinutes(it.total_minutes)}</td>
                <td className="mono text-sm">
                  {it.overtime_minutes > 0 ? formatMinutes(it.overtime_minutes) : "—"}
                </td>
                <td>
                  <FlagText item={it} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
      </div>
      )}

      {drawerItem && (
        <AttendanceDrawer item={drawerItem} onClose={() => setDrawerItem(null)} />
      )}

      <PdfOptionsModal
        open={pdfModalOpen}
        onClose={() => {
          if (!pdfBusy) setPdfModalOpen(false);
        }}
        onConfirm={handlePdfConfirm}
        busy={pdfBusy}
      />
      {confidentialModal}

      {sendModalOpen && (
        <SendEmailModal
          items={list.data?.items ?? []}
          date={date}
          sendEmails={sendEmails}
          initialResult={sendResult}
          onClose={() => {
            setSendModalOpen(false);
            setSendResult(null);
          }}
          onSent={(r) => setSendResult(r)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// SendEmailModal
// ---------------------------------------------------------------------------

const STATUS_PILL: Record<string, string> = {
  present: "pill pill-success",
  late: "pill pill-warning",
  absent: "pill pill-danger",
};

function SendEmailModal({
  items,
  date,
  sendEmails,
  initialResult,
  onClose,
  onSent,
}: {
  items: AttendanceItem[];
  date: string;
  sendEmails: ReturnType<typeof useSendTodayAttendanceEmails>;
  initialResult: SendTodayResult | null;
  onClose: () => void;
  onSent: (r: SendTodayResult) => void;
}) {
  const { t } = useTranslation();
  // Only employees that could plausibly receive an email (skip weekends/holidays).
  const sendable = items.filter(
    (it) => !it.is_weekend && !it.is_holiday && (it.absent || it.in_time),
  );

  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    () => new Set(sendable.map((i) => i.employee_id)),
  );
  const [result, setResult] = useState<SendTodayResult | null>(initialResult);
  const [error, setError] = useState<string | null>(null);
  const [modalPage, setModalPage] = useState(1);

  const MODAL_PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(sendable.length / MODAL_PAGE_SIZE));
  const pagedSendable = sendable.slice(
    (modalPage - 1) * MODAL_PAGE_SIZE,
    modalPage * MODAL_PAGE_SIZE,
  );

  const allSelected =
    sendable.length > 0 &&
    sendable.every((i) => selectedIds.has(i.employee_id));

  const toggle = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds(
      allSelected
        ? new Set()
        : new Set(sendable.map((i) => i.employee_id)),
    );
  };

  const doSend = async (resend = false) => {
    setError(null);
    try {
      const r = await sendEmails.mutateAsync({
        ...(selectedIds.size < sendable.length
          ? { employeeIds: [...selectedIds] }
          : {}),
        date,
        ...(resend ? { resend: true } : {}),
      });
      setResult(r);
      onSent(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    }
  };

  const alreadySentCount = result?.already_queued ?? 0;
  const isPending = sendEmails.isPending;

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-labelledby="send-email-modal-title"
        className="modal at-modal"
      >
        {/* Header */}
        <div className="modal-head at-modal-head">
          <div>
            <h2 id="send-email-modal-title" className="modal-title">
              {t("dailyAttendance.sendModal.title", { defaultValue: "Send attendance emails" })}
            </h2>
            <p className="at-modal-sub">
              {t("dailyAttendance.sendModal.sub", {
                defaultValue: "Date: {{date}} · {{selected}} of {{total}} employees selected",
                date,
                selected: selectedIds.size,
                total: sendable.length,
              })}
            </p>
          </div>
          <button
            className="icon-btn"
            aria-label={t("common.close", { defaultValue: "Close" })}
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">

          {/* Error */}
          {error && (
            <div className="at-notice tone-danger" role="alert">
              <span className="at-notice-text">{error}</span>
            </div>
          )}

          {/* Result view */}
          {result && (
            <div className="at-stack">
              <div className="at-result-box">
                <strong>
                  {t("dailyAttendance.sendModal.summary", {
                    defaultValue: "{{sent}} sent · {{already}} already sent · {{failed}} failed · {{skipped}} skipped",
                    sent: result.sent,
                    already: result.already_queued,
                    failed: result.failed,
                    skipped: result.skipped + result.toggle_off,
                  })}
                </strong>
                <div className="at-row" style={{ marginTop: 8, gap: 5 }}>
                  {result.results.map((r) => {
                    const ok = r.outcome === "sent" || r.outcome === "already_sent";
                    const bad = r.outcome === "failed";
                    return (
                      <span
                        key={`${r.employee_id}-${r.status ?? "none"}`}
                        className={`pill ${ok ? "pill-success" : bad ? "pill-danger" : "pill-neutral"}`}
                        title={r.error ?? r.recipient_email ?? undefined}
                      >
                        {r.employee_name} ·{" "}
                        {r.status ?? "—"} ·{" "}
                        {r.outcome.replace(/_/g, " ")}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Resend prompt — only when some were already sent */}
              {alreadySentCount > 0 && (
                <div className="at-notice tone-warning" style={{ display: "block" }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    {t("dailyAttendance.sendModal.alreadySent", {
                      defaultValue: "{{count}} employees already received an email.",
                      count: alreadySentCount,
                    })}
                  </div>
                  <div className="text-sm" style={{ marginBottom: 10 }}>
                    {t("dailyAttendance.sendModal.resendQuestion", { defaultValue: "Do you want to send again to those employees?" })}
                  </div>
                  <button
                    className="btn btn-sm"
                    disabled={isPending}
                    onClick={() => void doSend(true)}
                  >
                    {isPending
                      ? t("dailyAttendance.sendModal.sending", { defaultValue: "Sending…" })
                      : t("dailyAttendance.sendModal.resend", { defaultValue: "Send again to {{count}} employees", count: alreadySentCount })}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Employee list — only show when no result yet */}
          {!result && (
            <>
              {sendable.length === 0 ? (
                <p className="at-center-note">
                  {t("dailyAttendance.sendModal.noneSendable", { defaultValue: "No employees with attendance status for this date." })}
                </p>
              ) : (
                <>
                  {/* Select all row */}
                  <label className="at-check-row at-check-row-all">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                    {t("dailyAttendance.sendModal.selectAll", { defaultValue: "Select all ({{count}})", count: sendable.length })}
                  </label>

                  {/* Per-employee rows (current page only) */}
                  {pagedSendable.map((it) => {
                    const status = it.absent
                      ? "absent"
                      : it.late
                        ? "late"
                        : it.in_time
                          ? "present"
                          : null;
                    const checked = selectedIds.has(it.employee_id);
                    return (
                      <label
                        key={it.employee_id}
                        className={`at-check-row${checked ? " is-checked" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(it.employee_id)}
                        />
                        <Avatar name={it.full_name} small />
                        <div className="at-check-main">
                          <div className="at-check-name">{it.full_name}</div>
                          <div className="at-check-meta">
                            <span className="mono">{it.employee_code}</span> · {it.department.name}
                          </div>
                        </div>
                        {status && (
                          <span className={STATUS_PILL[status] ?? "pill pill-neutral"}>
                            {t(STAT_LABEL_KEY[status])}
                          </span>
                        )}
                      </label>
                    );
                  })}

                  {/* Pagination strip */}
                  {totalPages > 1 && (
                    <div className="at-modal-pager">
                      <button
                        className="btn btn-sm"
                        disabled={modalPage === 1}
                        onClick={() => setModalPage((p) => p - 1)}
                      >
                        <Icon name="chevronLeft" size={12} />
                        {t("common.previous", { defaultValue: "Previous" })}
                      </button>
                      <span>
                        {t("dailyAttendance.sendModal.pageOf", {
                          defaultValue: "Page {{page}} of {{total}} · {{count}} total",
                          page: modalPage,
                          total: totalPages,
                          count: sendable.length,
                        })}
                      </span>
                      <button
                        className="btn btn-sm"
                        disabled={modalPage === totalPages}
                        onClick={() => setModalPage((p) => p + 1)}
                      >
                        {t("common.next", { defaultValue: "Next" })}
                        <Icon name="chevronRight" size={12} />
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="modal-foot at-modal-foot">
          {result ? (
            <button className="btn btn-primary" onClick={onClose}>
              {t("common.done", { defaultValue: "Done" })}
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                {t("common.cancel", { defaultValue: "Cancel" })}
              </button>
              <button
                className="btn btn-primary"
                disabled={selectedIds.size === 0 || isPending}
                onClick={() => void doSend(false)}
              >
                {isPending
                  ? t("dailyAttendance.sendModal.sending", { defaultValue: "Sending…" })
                  : t("dailyAttendance.sendModal.sendTo", { defaultValue: "Send to {{count}} employees", count: selectedIds.size })}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SegBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`seg-btn at-seg-btn${active ? " active" : ""}`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
    >
      <span aria-hidden className="at-seg-icon">
        {icon}
      </span>
      {children}
    </button>
  );
}

function StatusPill({ item }: { item: AttendanceItem }) {
  const { t } = useTranslation();
  // Order matters: leave / holiday / weekend take priority over
  // workday verdicts so a row on a non-working day never reads as
  // "Absent" or falls through to "Present" with no in_time.
  if (item.leave_type_id !== null) {
    return <DotPill tone="info">{t("dailyAttendance.pill.onLeave")}</DotPill>;
  }
  if (item.is_holiday && !item.in_time) {
    return (
      <DotPill tone="accent">
        {item.holiday_name
          ? t("dailyAttendance.pill.holidayNamed", { name: item.holiday_name })
          : t("dailyAttendance.pill.holiday")}
      </DotPill>
    );
  }
  if (item.is_weekend && !item.in_time) {
    return <DotPill tone="neutral">{t("dailyAttendance.pill.weekend")}</DotPill>;
  }
  if (item.pending) {
    return <DotPill tone="info">{t("dailyAttendance.pill.waitingLogin")}</DotPill>;
  }
  // No in_time on a workday → Absent, regardless of the engine's
  // ``absent`` flag. Operators read "Present" as "checked in
  // today"; rows without a recorded check-in shouldn't be Present.
  if (!item.in_time) {
    return <DotPill tone="danger">{t("dailyAttendance.pill.absent")}</DotPill>;
  }
  if (item.late) {
    return <DotPill tone="warning">{t("dailyAttendance.pill.late")}</DotPill>;
  }
  return <DotPill tone="success">{t("dailyAttendance.pill.present")}</DotPill>;
}

/** Empty state for the daily table — the message follows what made the
 *  list empty: nothing computed for the date, a search with no hits, a
 *  status card with nothing in it, or a mix of filters. */
function DailyEmptyState({
  hasRows,
  searchQuery,
  statusLabel,
  onClear,
  onRegenerate,
  regenerating,
}: {
  hasRows: boolean;
  searchQuery: string;
  statusLabel: string | null;
  onClear: () => void;
  onRegenerate: (() => void) | null;
  regenerating: boolean;
}) {
  const { t } = useTranslation();
  if (!hasRows) {
    return (
      <EmptyPanel
        tone="accent"
        icon={<StrokeIcon>{ATT_ICON.calendar}</StrokeIcon>}
        title={t("dailyAttendance.empty.noneTitle", { defaultValue: "No attendance for this date yet" })}
        body={`${t("dailyAttendance.emptyDate.prefix")} ${t("dailyAttendance.regenerate")}${t("dailyAttendance.emptyDate.suffix")}`}
        actions={
          onRegenerate ? (
            <button type="button" className="btn btn-primary" onClick={onRegenerate} disabled={regenerating}>
              <Icon name="refresh" size={12} />
              {regenerating ? t("dailyAttendance.regenerating") : t("dailyAttendance.regenerate")}
            </button>
          ) : undefined
        }
      />
    );
  }
  let title: string;
  let body: string;
  let icon = <Icon name="filter" size={28} />;
  if (searchQuery && !statusLabel) {
    icon = <Icon name="search" size={28} />;
    title = t("dailyAttendance.empty.searchTitle", { defaultValue: "No one matches \"{{q}}\"", q: searchQuery });
    body = t("dailyAttendance.empty.searchBody", { defaultValue: "Try a different name or employee ID, or clear the search." });
  } else if (statusLabel && !searchQuery) {
    icon = <Icon name="check" size={28} />;
    title = t("dailyAttendance.statusFilter.empty", { label: statusLabel });
    body = t("dailyAttendance.empty.statusBody", { defaultValue: "Nobody in this view falls in that status for the selected date." });
  } else {
    title = t("dailyAttendance.empty.filtersTitle", { defaultValue: "No employees match these filters" });
    body = t("dailyAttendance.empty.filtersBody", { defaultValue: "Loosen the search or status filter to see more people." });
  }
  return (
    <EmptyPanel
      tone="neutral"
      icon={icon}
      title={title}
      body={body}
      actions={
        <button type="button" className="btn" onClick={onClear}>
          <Icon name="refresh" size={12} />
          {t("dailyAttendance.empty.clearFilters", { defaultValue: "Clear filters" })}
        </button>
      }
    />
  );
}

function FlagText({ item }: { item: AttendanceItem }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (item.early_out) parts.push(t("dailyAttendance.flag.earlyOut"));
  if (item.short_hours) parts.push(t("dailyAttendance.flag.shortHours"));
  if (item.overtime_minutes > 0) {
    parts.push(t("dailyAttendance.flag.ot", { value: formatMinutes(item.overtime_minutes) }));
  }
  if (parts.length === 0) {
    return <span className="text-xs text-dim">—</span>;
  }
  return <span className="text-xs">{parts.join(" · ")}</span>;
}

// Avatar — accent-gradient circle with up to two initials (the shared
// ``.avatar`` look from the shell, sized for table rows).
function Avatar({ name, small }: { name: string; small?: boolean }) {
  const initials = (() => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 0) return "?";
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (first + last).toUpperCase() || "?";
  })();
  return (
    <span aria-hidden className={`at-avatar${small ? " sm" : ""}`}>
      {initials}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hook factory — applies the tenant's time format (migration 0068)
 * to backend "HH:MM:SS" local strings. Backend has already
 * converted to the tenant tz; this just picks 12h vs 24h.
 */
function useShortTime(): (iso: string | null) => string {
  const dt = useTenantDateTime();
  return (iso: string | null) => {
    if (!iso) return "—";
    return dt.formatLocalTime(iso);
  };
}


// Re-export FlagPills for any consumer that imports it from here
// (the AttendanceDrawer used to use it).
export function FlagPills({ item }: { item: AttendanceItem }) {
  const { t } = useTranslation();
  if (item.leave_type_id !== null) {
    return <span className="pill pill-info">{t("dailyAttendance.pillLower.onLeave")}</span>;
  }
  if (item.pending) {
    return <span className="pill pill-info">{t("dailyAttendance.pillLower.waiting")}</span>;
  }
  if (item.absent) {
    return <span className="pill pill-danger">{t("dailyAttendance.pillLower.absent")}</span>;
  }
  return (
    <div className="at-row" style={{ gap: 4 }}>
      {item.late && <span className="pill pill-warning">{t("dailyAttendance.pillLower.late")}</span>}
      {item.early_out && <span className="pill pill-warning">{t("dailyAttendance.pillLower.early")}</span>}
      {item.short_hours && <span className="pill pill-info">{t("dailyAttendance.pillLower.short")}</span>}
      {item.overtime_minutes > 0 && (
        <span className="pill pill-accent">
          {t("dailyAttendance.flag.ot", { value: formatMinutes(item.overtime_minutes) })}
        </span>
      )}
      {!item.late &&
        !item.early_out &&
        !item.short_hours &&
        item.overtime_minutes === 0 && (
          <span className="pill pill-success">{t("dailyAttendance.pillLower.onTime")}</span>
        )}
    </div>
  );
}
