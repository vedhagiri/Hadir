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

type ScopeMode = "company" | "department" | "team" | "individual";

// The status buckets shown as stat cards (and now click-to-filter chips).
type DayStatus = "present" | "late" | "absent" | "onLeave" | "pending" | "offDay";

// Single source of truth for a row's status bucket. Used by BOTH the
// stat-card counts and the click-to-filter logic, so a card's number is
// always exactly the number of rows clicking it filters to. The order
// mirrors the StatusPill priority: leave > off-day > pending > absent >
// late > present.
function classifyStatus(it: AttendanceItem): DayStatus | "other" {
  if (it.absent && it.leave_type_id !== null) return "onLeave";
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

  // Sticky-stack measurement. Four sticky regions stack on each other
  // (each with its own ``top`` = sum of the heights of everything above
  // it), so there's no card-split seam and no z-index overlap:
  //
  //   ┌──────────────────────────────┐  ← topStickyRef
  //   │ page header + regen + filter │     top: 0
  //   │ + stat tiles                 │
  //   ├──────────────────────────────┤  ← cardHeadRef  (inside card)
  //   │ "Attendance for {date}" head │     top: topH
  //   ├──────────────────────────────┤  ← anomalyRef   (inside card)
  //   │ anomaly info banner          │     top: topH + cardHeadH
  //   ├──────────────────────────────┤  ← <th>          (inside card)
  //   │ EMPLOYEE  DEPT  STATUS …     │     top: topH + cardHeadH + anomalyH
  //   ├──────────────────────────────┤
  //   │ scrolling tbody rows         │
  //
  // ``useLayoutEffect`` so the heights are set before the first paint —
  // no first-frame flash where the thead briefly overlaps the controls.
  // ``getBoundingClientRect().height`` (not offsetHeight) + Math.round
  // so any sub-pixel jitter from inherited transforms doesn't oscillate
  // the offsets every frame.
  const topStickyRef = useRef<HTMLDivElement | null>(null);
  const cardHeadRef = useRef<HTMLDivElement | null>(null);
  const anomalyRef = useRef<HTMLDivElement | null>(null);
  const [topH, setTopH] = useState(0);
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
      measure(topStickyRef.current, setTopH),
      measure(cardHeadRef.current, setCardHeadH),
      measure(anomalyRef.current, setAnomalyH),
    ];
    return () => {
      for (const ro of obs) ro?.disconnect();
    };
  }, []);
  const theadTop = topH + cardHeadH + anomalyH;

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
      {/* Top sticky region — page header, action buttons, filter row
          (with live employee search), and the summary stat tiles.
          Anchored at top:0 of the .content scroll container. The card
          head / anomaly / thead each pin under this with their own
          measured offsets (see ``topH``, ``cardHeadH``, ``anomalyH``). */}
      {/* Sticky bg cover for ``.content``'s padding-top:20px zone.
          Without this 20px strip the sticky page-header below pins at
          the padding-edge top, leaving an open 20px gap between the
          topbar and the wrapper where scrolling tbody rows briefly
          show through (the bleed in the original bug screenshot).
          ``top: -20`` + ``marginTop: -20`` aligns the sticky pin
          with the wrapper's natural position so the cover sits at
          y=topbar-bottom through every scroll position. */}
      <div
        aria-hidden
        style={{
          position: "sticky",
          top: -20,
          zIndex: 31,
          height: 0,
          marginTop: -20,
          paddingTop: 20,
          background: "var(--bg)",
        }}
      />
      <div
        ref={topStickyRef}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 30,
          background: "var(--bg)",
          paddingBottom: 0,
        }}
      >
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
              <span aria-hidden style={{ marginInlineEnd: 4 }}>✉</span>
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
            <span aria-hidden style={{ marginInlineEnd: 4 }}>↻</span>
            {regenerate.isPending
              ? t("dailyAttendance.regenerating")
              : t("dailyAttendance.regenerate")}
          </button>
          <button
            className="btn btn-primary"
            onClick={requestXlsx}
            disabled={!list.data}
          >
            <span aria-hidden style={{ marginInlineEnd: 4 }}>⬇</span>
            {t("dailyAttendance.downloadXlsx")}
          </button>
        </div>
      </div>

      {regenInfo && (
        <div
          className="card"
          style={{
            padding: "10px 14px",
            marginBottom: 12,
            background: "var(--info-soft, var(--bg-sunken))",
            borderColor: "var(--info, var(--border))",
            fontSize: 13,
          }}
        >
          {regenInfo}
        </div>
      )}


      {/* Filter row */}
      <div
        className="card"
        style={{
          padding: "12px 14px",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
            }}
          >
            {t("dailyAttendance.date")}
          </span>
          <DatePicker
            value={date}
            onChange={setDate}
            max={todayIso()}
            ariaLabel={t("dailyAttendance.dateAria")}
          />
        </div>

        {/* Live search — name or employee code. Filters the rendered
            rows only; stats above stay on the full scope. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "4px 10px",
            minWidth: 220,
          }}
        >
          <span aria-hidden style={{ opacity: 0.6, fontSize: 13 }}>🔎</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("dailyAttendance.searchPlaceholder")}
            aria-label={t("dailyAttendance.searchAria")}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text)",
              fontSize: 13,
              padding: "2px 0",
              minWidth: 140,
            }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label={t("dailyAttendance.clearSearchAria")}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-tertiary)",
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
                padding: 2,
              }}
            >
              ×
            </button>
          )}
        </div>

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
          <select
            value={departmentId ?? ""}
            onChange={(e) =>
              setDepartmentId(
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
            style={selectStyle}
          >
            <option value="">{t("dailyAttendance.allDepartments")}</option>
            {(departmentsQuery.data?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}

        {scopeMode === "individual" && (
          <select
            value={employeeId ?? ""}
            onChange={(e) =>
              setEmployeeId(
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
            style={{ ...selectStyle, minWidth: 220 }}
          >
            <option value="">{t("dailyAttendance.selectEmployee")}</option>
            {(employeesQuery.data?.items ?? []).map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.full_name} · {emp.employee_code}
              </option>
            ))}
          </select>
        )}

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
            style={{ fontStyle: "italic" }}
            title={t("dailyAttendance.teamHintOtherTitle")}
          >
            {t("dailyAttendance.teamHintOther")}
          </span>
        )}

        <div style={{ flex: 1 }} />

        <span
          className="text-xs text-dim"
          style={{ whiteSpace: "nowrap" }}
        >
          {list.data
            ? t("dailyAttendance.inScope", { count: stats.total })
            : "—"}
        </span>
      </div>

      {/* 5 stat cards */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <StatTile
          label={t("dailyAttendance.stat.inScope")}
          value={stats.total}
          onClick={() => setStatusFilter(null)}
          active={statusFilter === null}
        />
        <StatTile
          label={t("dailyAttendance.stat.present")}
          value={stats.present}
          tone="success"
          onClick={() => toggleStatus("present")}
          active={statusFilter === "present"}
        />
        <StatTile
          label={t("dailyAttendance.stat.late")}
          value={stats.late}
          tone="warning"
          onClick={() => toggleStatus("late")}
          active={statusFilter === "late"}
        />
        <StatTile
          label={t("dailyAttendance.stat.absent")}
          value={stats.absent}
          tone="danger"
          onClick={() => toggleStatus("absent")}
          active={statusFilter === "absent"}
        />
        {stats.pending > 0 && (
          <StatTile
            label={t("dailyAttendance.stat.waiting")}
            value={stats.pending}
            tone="info"
            onClick={() => toggleStatus("pending")}
            active={statusFilter === "pending"}
          />
        )}
        {stats.offDay > 0 && (
          <StatTile
            label={t("dailyAttendance.stat.offDay")}
            value={stats.offDay}
            onClick={() => toggleStatus("offDay")}
            active={statusFilter === "offDay"}
          />
        )}
        <StatTile
          label={t("dailyAttendance.stat.onLeave")}
          value={stats.onLeave}
          tone="info"
          onClick={() => toggleStatus("onLeave")}
          active={statusFilter === "onLeave"}
        />
      </div>

      </div>{/* /top sticky wrapper — page-header + filter + stats end here */}

      {/* Single table card. Inside it, three child regions each use
          position: sticky with a stacked ``top`` offset:
            1. card-head  → pins below the top-sticky wrapper
            2. anomaly    → pins below card-head
            3. each <th>  → pins below anomaly
          No card-splitting, no visible seam, no z-index overlap. */}
      <div className="card">
        <div
          ref={cardHeadRef}
          className="card-head"
          style={{
            position: "sticky",
            top: topH,
            zIndex: 25,
            background: "var(--bg-elev, #fff)",
            // The card-head's natural border-bottom needs to stay
            // visible when pinned so it reads as a divider, not a
            // floating row.
          }}
        >
          <div>
            <h3 className="card-title">
              {t("dailyAttendance.cardTitle", { date: list.data?.date ?? date })}
              {searchQuery && (
                <span
                  style={{
                    marginInlineStart: 8,
                    fontSize: 12,
                    color: "var(--text-tertiary)",
                    fontWeight: 400,
                  }}
                >
                  · {t("dailyAttendance.matchFor", { count: filteredItems.length, query: searchQuery })}
                </span>
              )}
              {statusFilter && (
                <span
                  style={{
                    marginInlineStart: 8,
                    fontSize: 12,
                    color: "var(--text-tertiary)",
                    fontWeight: 400,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  · {t("dailyAttendance.statusFilter.showing", {
                    label: t(STAT_LABEL_KEY[statusFilter]),
                    count: filteredItems.length,
                  })}
                  <button
                    type="button"
                    onClick={() => setStatusFilter(null)}
                    aria-label={t("dailyAttendance.statusFilter.clearAria")}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--accent)",
                      cursor: "pointer",
                      fontSize: 14,
                      lineHeight: 1,
                      padding: 2,
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
            </h3>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={requestPdf}
              disabled={!list.data || pdfBusy}
            >
              <span aria-hidden style={{ marginInlineEnd: 4 }}>📄</span>
              {t("dailyAttendance.pdf")}
            </button>
            <button
              className="btn btn-sm"
              onClick={requestXlsx}
              disabled={!list.data}
            >
              <span aria-hidden style={{ marginInlineEnd: 4 }}>⬇</span>
              {t("dailyAttendance.xlsx")}
            </button>
          </div>
        </div>
        <div
          ref={anomalyRef}
          style={{
            position: "sticky",
            top: topH + cardHeadH,
            zIndex: 22,
            background: "var(--bg-elev, #fff)",
          }}
        >
          <AnomalyInfoBanner message={t("dailyAttendance.anomalyNote")} />
        </div>

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
                <th
                  key={key}
                  style={{
                    position: "sticky",
                    top: theadTop,
                    zIndex: 18,
                    background: "var(--bg-elev, #fff)",
                  }}
                >
                  {t(`dailyAttendance.col.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td
                  colSpan={8}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  {t("dailyAttendance.loading")}
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={8}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  {t("dailyAttendance.loadFailed")}
                </td>
              </tr>
            )}
            {filteredItems.map((it) => (
              <tr
                key={`${it.employee_id}-${it.date}`}
                onClick={() => setDrawerItem(it)}
                style={{ cursor: "pointer" }}
              >
                <td>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <Avatar name={it.full_name} seed={it.employee_code} />
                    <div>
                      <div
                        style={{
                          fontWeight: 500,
                          fontSize: 13,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          color:
                            it.employee_status === "inactive"
                              ? "var(--text-secondary)"
                              : undefined,
                          textDecoration:
                            it.employee_status === "inactive"
                              ? "line-through"
                              : undefined,
                        }}
                      >
                        {it.full_name}
                        {it.employee_status === "inactive" && (
                          <span
                            className="pill pill-neutral"
                            style={{
                              fontSize: 10,
                              textDecoration: "none",
                            }}
                          >
                            {t("dailyAttendance.archived")}
                          </span>
                        )}
                      </div>
                      <div className="mono text-xs text-dim">
                        {it.employee_code}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="text-sm">{it.department.name}</td>
                <td>
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
            {list.data && list.data.items.length === 0 && !list.isLoading && (
              <tr>
                <td
                  colSpan={8}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  {t("dailyAttendance.emptyDate.prefix")}{" "}
                  <em>{t("dailyAttendance.regenerate")}</em>
                  {t("dailyAttendance.emptyDate.suffix")}
                </td>
              </tr>
            )}
            {list.data &&
              list.data.items.length > 0 &&
              filteredItems.length === 0 &&
              !list.isLoading &&
              searchQuery && (
                <tr>
                  <td
                    colSpan={8}
                    className="text-sm text-dim"
                    style={{ padding: 16 }}
                  >
                    {t("dailyAttendance.emptySearch.prefix", { query: searchQuery })}{" "}
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--accent)",
                        cursor: "pointer",
                        padding: 0,
                        font: "inherit",
                        textDecoration: "underline",
                      }}
                    >
                      {t("dailyAttendance.emptySearch.clear")}
                    </button>
                    .
                  </td>
                </tr>
              )}
            {list.data &&
              list.data.items.length > 0 &&
              filteredItems.length === 0 &&
              !list.isLoading &&
              !searchQuery &&
              statusFilter && (
                <tr>
                  <td
                    colSpan={8}
                    className="text-sm text-dim"
                    style={{ padding: 16 }}
                  >
                    {t("dailyAttendance.statusFilter.empty", {
                      label: t(STAT_LABEL_KEY[statusFilter]),
                    })}{" "}
                    <button
                      type="button"
                      onClick={() => setStatusFilter(null)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--accent)",
                        cursor: "pointer",
                        padding: 0,
                        font: "inherit",
                        textDecoration: "underline",
                      }}
                    >
                      {t("dailyAttendance.statusFilter.clear")}
                    </button>
                    .
                  </td>
                </tr>
              )}
          </tbody>
        </table>
      </div>

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

const STATUS_COLOR: Record<string, string> = {
  present: "#0a8a52",
  late: "#b45309",
  absent: "#b91c1c",
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
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 540,
          maxWidth: "92vw",
          maxHeight: "88vh",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius)",
          zIndex: 60,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div>
            <h2
              id="send-email-modal-title"
              style={{ margin: 0, fontSize: 17, fontWeight: 700 }}
            >
              ✉ Send Attendance Emails
            </h2>
            <p style={{ margin: "3px 0 0", fontSize: 12, color: "var(--text-secondary)" }}>
              Date: <strong>{date}</strong> · {selectedIds.size} of{" "}
              {sendable.length} employee{sendable.length !== 1 ? "s" : ""} selected
            </p>
          </div>
          <button
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
            style={{ marginTop: 2 }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>

          {/* Error */}
          {error && (
            <div
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                border: "1px solid var(--danger-border, #fecaca)",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 12.5,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}

          {/* Result view */}
          {result && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  background: "var(--bg-sunken)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 14px",
                  fontSize: 12.5,
                }}
              >
                <strong>
                  {result.sent} sent · {result.already_queued} already sent ·{" "}
                  {result.failed} failed · {result.skipped + result.toggle_off} skipped
                </strong>
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 5,
                  }}
                >
                  {result.results.map((r) => {
                    const ok = r.outcome === "sent" || r.outcome === "already_sent";
                    const bad = r.outcome === "failed";
                    return (
                      <span
                        key={`${r.employee_id}-${r.status ?? "none"}`}
                        className="pill pill-neutral"
                        title={r.error ?? r.recipient_email ?? undefined}
                        style={{
                          fontSize: 11.5,
                          color: ok
                            ? "var(--success, #0a8a52)"
                            : bad
                              ? "var(--danger-text, #b91c1c)"
                              : "var(--text-secondary)",
                        }}
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
                <div
                  style={{
                    marginTop: 10,
                    background: "color-mix(in srgb, #f59e0b 10%, transparent)",
                    border: "1px solid #f59e0b",
                    borderRadius: 10,
                    padding: "12px 16px",
                    fontSize: 13,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    ⚠ {alreadySentCount} employee
                    {alreadySentCount !== 1 ? "s" : ""} already received an
                    email.
                  </div>
                  <div style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 10 }}>
                    Do you want to send again to those employees?
                  </div>
                  <button
                    className="btn"
                    style={{ borderColor: "#f59e0b", color: "#92400e" }}
                    disabled={isPending}
                    onClick={() => void doSend(true)}
                  >
                    {isPending ? "Sending…" : `Send again to ${alreadySentCount} employee${alreadySentCount !== 1 ? "s" : ""}`}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Employee list — only show when no result yet */}
          {!result && (
            <>
              {sendable.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13, textAlign: "center", padding: "20px 0" }}>
                  No employees with attendance status for this date.
                </p>
              ) : (
                <>
                  {/* Select all row */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "6px 0 10px",
                      borderBottom: "1px solid var(--border)",
                      marginBottom: 6,
                      cursor: "pointer",
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                    Select all ({sendable.length})
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
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px 6px",
                          borderRadius: 8,
                          cursor: "pointer",
                          background: checked
                            ? "var(--bg-elev)"
                            : "transparent",
                          transition: "background 0.1s",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(it.employee_id)}
                        />
                        <Avatar name={it.full_name} seed={it.employee_code} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>
                            {it.full_name}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            {it.employee_code} · {it.department.name}
                          </div>
                        </div>
                        {status && (
                          <span
                            className="pill pill-neutral"
                            style={{
                              fontSize: 11,
                              color: STATUS_COLOR[status] ?? "var(--text-secondary)",
                              flexShrink: 0,
                            }}
                          >
                            {status}
                          </span>
                        )}
                      </label>
                    );
                  })}

                  {/* Pagination strip */}
                  {totalPages > 1 && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        paddingTop: 10,
                        marginTop: 6,
                        borderTop: "1px solid var(--border)",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                      }}
                    >
                      <button
                        className="btn btn-sm"
                        disabled={modalPage === 1}
                        onClick={() => setModalPage((p) => p - 1)}
                        style={{ minWidth: 72 }}
                      >
                        ← Previous
                      </button>
                      <span>
                        Page {modalPage} of {totalPages} &nbsp;·&nbsp; {sendable.length} total
                      </span>
                      <button
                        className="btn btn-sm"
                        disabled={modalPage === totalPages}
                        onClick={() => setModalPage((p) => p + 1)}
                        style={{ minWidth: 72 }}
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {result ? (
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={selectedIds.size === 0 || isPending}
                onClick={() => void doSend(false)}
              >
                {isPending
                  ? "Sending…"
                  : `Send to ${selectedIds.size} employee${selectedIds.size !== 1 ? "s" : ""}`}
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
      className={`seg-btn${active ? " active" : ""}`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span aria-hidden style={{ fontSize: 11 }}>
        {icon}
      </span>
      {children}
    </button>
  );
}

function StatTile({
  label,
  value,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning" | "danger" | "info";
  onClick?: () => void;
  active?: boolean;
}) {
  const toneBg: Record<string, string> = {
    success: "var(--success-soft)",
    warning: "var(--warning-soft)",
    danger: "var(--danger-soft)",
    info: "var(--info-soft, var(--bg-sunken))",
  };
  const toneColor: Record<string, string> = {
    success: "var(--success-text)",
    warning: "var(--warning-text)",
    danger: "var(--danger-text)",
    info: "var(--info-text, var(--text-secondary))",
  };
  const bg = tone ? toneBg[tone] : "var(--bg-elev)";
  const labelColor = tone ? toneColor[tone] : "var(--text-tertiary)";
  const clickable = !!onClick;
  return (
    <div
      className="stat"
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={clickable ? !!active : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={{
        background: bg,
        border: tone ? "1px solid transparent" : undefined,
        cursor: clickable ? "pointer" : undefined,
        // Outline (not border) for the active ring so toggling it never
        // shifts the tile's layout.
        outline: active ? "2px solid var(--accent)" : undefined,
        outlineOffset: active ? "-2px" : undefined,
        position: "relative",
      }}
    >
      <div className="stat-label" style={{ color: labelColor }}>
        {label}
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function StatusPill({ item }: { item: AttendanceItem }) {
  const { t } = useTranslation();
  // Order matters: leave / holiday / weekend take priority over
  // workday verdicts so a row on a non-working day never reads as
  // "Absent" or falls through to "Present" with no in_time.
  if (item.absent && item.leave_type_id !== null) {
    return <span className="pill pill-info">{t("dailyAttendance.pill.onLeave")}</span>;
  }
  if (item.is_holiday && !item.in_time) {
    return (
      <span className="pill pill-info">
        {item.holiday_name
          ? t("dailyAttendance.pill.holidayNamed", { name: item.holiday_name })
          : t("dailyAttendance.pill.holiday")}
      </span>
    );
  }
  if (item.is_weekend && !item.in_time) {
    return <span className="pill pill-neutral">{t("dailyAttendance.pill.weekend")}</span>;
  }
  if (item.pending) {
    return <span className="pill pill-info">{t("dailyAttendance.pill.waitingLogin")}</span>;
  }
  // No in_time on a workday → Absent, regardless of the engine's
  // ``absent`` flag. Operators read "Present" as "checked in
  // today"; rows without a recorded check-in shouldn't be Present.
  if (!item.in_time) {
    return <span className="pill pill-danger">{t("dailyAttendance.pill.absent")}</span>;
  }
  if (item.late) {
    return <span className="pill pill-warning">{t("dailyAttendance.pill.late")}</span>;
  }
  return <span className="pill pill-success">{t("dailyAttendance.pill.present")}</span>;
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

// Avatar — colored circle with up to two initials. Color is derived
// deterministically from ``seed`` (employee_code) so the same person
// gets the same colour across pages.
function Avatar({ name, seed }: { name: string; seed: string }) {
  const initials = (() => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 0) return "?";
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (first + last).toUpperCase() || "?";
  })();
  const palette = [
    "#1f7ae0",
    "#0aa57c",
    "#d97706",
    "#c026d3",
    "#dc2626",
    "#0891b2",
    "#7c3aed",
    "#65a30d",
    "#b45309",
    "#be185d",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const bg = palette[Math.abs(hash) % palette.length] ?? palette[0];
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: bg,
        color: "white",
        fontSize: 12,
        fontWeight: 600,
        flexShrink: 0,
        letterSpacing: "0.02em",
      }}
    >
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

const selectStyle = {
  padding: "6px 10px",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;

// Re-export FlagPills for any consumer that imports it from here
// (the AttendanceDrawer used to use it).
export function FlagPills({ item }: { item: AttendanceItem }) {
  const { t } = useTranslation();
  if (item.absent && item.leave_type_id !== null) {
    return <span className="pill pill-info">{t("dailyAttendance.pillLower.onLeave")}</span>;
  }
  if (item.pending) {
    return <span className="pill pill-info">{t("dailyAttendance.pillLower.waiting")}</span>;
  }
  if (item.absent) {
    return <span className="pill pill-danger">{t("dailyAttendance.pillLower.absent")}</span>;
  }
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
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
