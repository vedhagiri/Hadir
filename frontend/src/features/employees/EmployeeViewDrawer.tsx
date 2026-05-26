// Read-only Employee detail drawer. Distinct from EmployeeDrawer
// (Add/Edit form) — opened from the kebab menu's "View" action.
//
// Two tabs:
//   * Details — all employee fields rendered as read-only labelled
//     rows (identity, assignment, lifecycle, photos, login/roles).
//   * Events  — detection events captured for this employee on
//     tenant cameras, paged. Reuses the camera-logs detection-events
//     query with the employee_id filter; same /crop endpoint serves
//     the per-row face thumbnail.
//
// Edit is intentionally NOT inline here — operators flip to the Edit
// drawer via the row's kebab menu (or the "Edit" button in this
// drawer's footer) so the read-only / write-mode boundary is
// explicit.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../../api/client";
import { AnomalyInfoBanner } from "../../components/AnomalyNote";
import { useMe } from "../../auth/AuthProvider";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { DrawerShell } from "../../components/DrawerShell";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { DayDetailContent } from "../calendar/DayDetailDrawer";
import { useDetectionEvents } from "../camera-logs/hooks";
import type { DetectionEvent } from "../camera-logs/types";
import { ClipDetailDrawer } from "../person-clips/PersonClipsPage";
import type {
  PersonClipListResponse,
  PersonClipOut,
} from "../person-clips/types";
import {
  useEmployeeDetail,
  useEmployeePhotos,
  useEmployeeTeamMembers,
} from "./hooks";
import type { Employee, Photo } from "./types";

type Tab = "details" | "events" | "attendance" | "team" | "clips";

// ---------------------------------------------------------------------------
// Resizable drawer
// ---------------------------------------------------------------------------

const DRAWER_WIDTH_KEY = "maugood.employee_drawer.width";
const DRAWER_DEFAULT_W = 540;
const DRAWER_MIN_W = 360;
const DRAWER_MAX_W_VW = 0.94;

function useResizableDrawer() {
  const [width, setWidth] = useState<number>(() => {
    try {
      const s = localStorage.getItem(DRAWER_WIDTH_KEY);
      if (s) {
        const n = parseInt(s, 10);
        if (!isNaN(n) && n >= DRAWER_MIN_W) return n;
      }
    } catch {}
    return DRAWER_DEFAULT_W;
  });

  const widthRef = useRef(width);
  widthRef.current = width;

  const isDragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const isRtlRef = useRef(false);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startW.current = widthRef.current;
    isRtlRef.current = document.documentElement.dir === "rtl";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);

  const resetWidth = useCallback(() => {
    setWidth(DRAWER_DEFAULT_W);
    try {
      localStorage.removeItem(DRAWER_WIDTH_KEY);
    } catch {}
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = isRtlRef.current
        ? e.clientX - startX.current
        : startX.current - e.clientX;
      const maxW = window.innerWidth * DRAWER_MAX_W_VW;
      const next = Math.max(DRAWER_MIN_W, Math.min(maxW, startW.current + dx));
      setWidth(next);
    };
    const onUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        localStorage.setItem(
          DRAWER_WIDTH_KEY,
          String(Math.round(widthRef.current)),
        );
      } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  return { width, onHandleMouseDown, resetWidth };
}

function ResizeHandle({
  onMouseDown,
  onDoubleClick,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isRtl = document.documentElement.dir === "rtl";

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-hidden="true"
      title="Drag to resize · Double-click to reset"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [isRtl ? "right" : "left"]: 0,
        width: 8,
        cursor: "col-resize",
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 4,
          borderRadius: 2,
          height: hovered ? 72 : 36,
          background: hovered ? "var(--accent)" : "var(--border)",
          transition: "height 0.15s ease, background 0.15s ease",
        }}
      />
    </div>
  );
}

export function EmployeeViewDrawer({
  employeeId,
  onClose,
  onEdit,
}: {
  employeeId: number;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const me = useMe();
  // Edit is Admin/HR-only on the backend, so hide the button for any
  // other role (Manager opening the drawer from My Team).
  const canEdit =
    me.data?.roles?.includes("Admin") || me.data?.roles?.includes("HR");
  const detail = useEmployeeDetail(employeeId);
  const photos = useEmployeePhotos(employeeId);
  const [tab, setTab] = useState<Tab>("details");
  const { width, onHandleMouseDown, resetWidth } = useResizableDrawer();

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer" style={{ width: `${width}px`, maxWidth: "none" }}>
        <ResizeHandle onMouseDown={onHandleMouseDown} onDoubleClick={resetWidth} />
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">
              {t("employees.view.label") as string}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {detail.data?.full_name ?? "—"}
            </div>
            {detail.data && (
              <div className="mono text-xs text-dim" style={{ marginTop: 2 }}>
                {detail.data.employee_code} · {detail.data.department.name}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {canEdit && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onClose();
                  onEdit();
                }}
                title={t("employees.action.edit") as string}
              >
                <Icon name="edit" size={11} />
                {t("employees.action.edit") as string}
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label={t("common.close") as string}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {/* Tab strip */}
        <nav
          aria-label={t("employees.view.tabs") as string}
          style={{
            display: "flex",
            gap: 4,
            borderBottom: "1px solid var(--border)",
            padding: "0 18px",
          }}
        >
          {(["details", "attendance", "events", "clips", "team"] as Tab[]).map((key) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-pressed={active}
                style={{
                  padding: "10px 12px",
                  fontSize: 13,
                  border: "none",
                  background: "transparent",
                  color: active ? "var(--text)" : "var(--text-secondary)",
                  borderBottom: active
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                  fontWeight: active ? 600 : 400,
                  marginBottom: -1,
                  cursor: "pointer",
                }}
              >
                {t(`employees.view.tab.${key}`) as string}
              </button>
            );
          })}
        </nav>

        <div className="drawer-body">
          {tab === "details" &&
            (detail.isLoading ? (
              <div className="text-sm text-dim">
                {t("common.loading") as string}…
              </div>
            ) : detail.data ? (
              <DetailsTab
                employee={detail.data}
                photos={photos.data?.items ?? []}
              />
            ) : (
              <div className="text-sm text-dim">
                {t("employees.loadFailed") as string}
              </div>
            ))}

          {tab === "events" && <EventsTab employeeId={employeeId} />}

          {tab === "attendance" && (
            <AttendanceTab employeeId={employeeId} />
          )}

          {tab === "team" && <TeamMembersTab employeeId={employeeId} />}

          {tab === "clips" && <MatchedClipsTab employeeId={employeeId} />}
        </div>
      </div>
    </DrawerShell>
  );
}

// ---------------------------------------------------------------------------
// Team Members tab
// ---------------------------------------------------------------------------

function TeamMembersTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const team = useEmployeeTeamMembers(employeeId);
  const [showTiers, setShowTiers] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  if (team.isLoading) {
    return (
      <div className="text-sm text-dim">{t("common.loading") as string}…</div>
    );
  }
  if (team.isError || !team.data) {
    return (
      <div className="text-sm" style={{ color: "var(--danger-text)" }}>
        {t("employees.team.loadFailed", {
          defaultValue: "Could not load team members.",
        }) as string}
      </div>
    );
  }

  const { scope, scope_name, items } = team.data;

  const needle = searchQuery.trim().toLowerCase();
  const filteredItems = needle
    ? items.filter(
        (m) =>
          m.employee_code.toLowerCase().includes(needle) ||
          m.full_name.toLowerCase().includes(needle) ||
          (m.designation ?? "").toLowerCase().includes(needle) ||
          (m.department_name ?? "").toLowerCase().includes(needle),
      )
    : items;

  const showFiltered = needle.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Scope + controls bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 12px",
          background: "var(--bg-sunken)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          fontSize: 12.5,
        }}
      >
        <div>
          <span className="text-xs text-dim" style={{ marginInlineEnd: 6 }}>
            {t("employees.team.scopeLabel", {
              defaultValue: "Scope",
            }) as string}
          </span>
          <span style={{ fontWeight: 500 }}>
            {t(`employees.team.scope.${scope}`, {
              defaultValue:
                scope === "division"
                  ? "Division"
                  : scope === "section"
                    ? "Section"
                    : "Department",
            }) as string}
            {" · "}
            {scope_name || "—"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowTiers((v) => !v)}
            aria-pressed={showTiers}
            title={
              showTiers
                ? (t("employees.team.hideTiers", {
                    defaultValue: "Hide org tiers",
                  }) as string)
                : (t("employees.team.showTiers", {
                    defaultValue: "Show org tiers",
                  }) as string)
            }
          >
            {showTiers
              ? (t("employees.team.hideTiers", {
                  defaultValue: "Hide org tiers",
                }) as string)
              : (t("employees.team.showTiers", {
                  defaultValue: "Show org tiers",
                }) as string)}
          </button>
          <span className="mono text-xs text-dim">
            {showFiltered ? (
              <>
                {filteredItems.length}
                <span style={{ opacity: 0.6 }}>/{items.length}</span>
              </>
            ) : (
              items.length
            )}{" "}
            {t("employees.team.members", {
              count: items.length,
              defaultValue: items.length === 1 ? "member" : "members",
            }) as string}
          </span>
        </div>
      </div>

      {/* Search bar */}
      <div style={{ position: "relative" }}>
        <span
          style={{
            position: "absolute",
            insetInlineStart: 10,
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
            color: "var(--text-dim)",
            display: "flex",
            alignItems: "center",
          }}
          aria-hidden="true"
        >
          <Icon name="search" size={14} />
        </span>
        <input
          type="search"
          className="input"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={
            t("employees.team.searchPlaceholder", {
              defaultValue: "Search by ID, name, designation or department…",
            }) as string
          }
          aria-label={
            t("employees.team.searchPlaceholder", {
              defaultValue: "Search by ID, name, designation or department…",
            }) as string
          }
          style={{ paddingInlineStart: 32, width: "100%" }}
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            aria-label={t("common.clear", { defaultValue: "Clear" }) as string}
            style={{
              position: "absolute",
              insetInlineEnd: 8,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 2,
              color: "var(--text-dim)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Icon name="x" size={13} />
          </button>
        )}
      </div>

      {/* Table or empty states */}
      {items.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: "32px 16px",
            color: "var(--text-dim)",
            fontSize: 13,
            textAlign: "center",
          }}
        >
          <Icon name="users" size={28} />
          {t("employees.team.empty", {
            defaultValue: "No other team members in this scope.",
          }) as string}
        </div>
      ) : filteredItems.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: "32px 16px",
            color: "var(--text-dim)",
            fontSize: 13,
            textAlign: "center",
          }}
        >
          <Icon name="search" size={28} />
          <div>
            {t("employees.team.noResults", {
              defaultValue: "No members match your search.",
            }) as string}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setSearchQuery("")}
          >
            {t("common.clearSearch", { defaultValue: "Clear search" }) as string}
          </button>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                  {t("employees.field.code", {
                    defaultValue: "Employee ID",
                  }) as string}
                </th>
                <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                  {t("employees.field.fullName", {
                    defaultValue: "Name",
                  }) as string}
                </th>
                <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                  {t("employees.field.designation", {
                    defaultValue: "Designation",
                  }) as string}
                </th>
                {showTiers && (
                  <>
                    <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                      {t("employees.team.col.division", {
                        defaultValue: "Division",
                      }) as string}
                    </th>
                    <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                      {t("employees.team.col.department", {
                        defaultValue: "Department",
                      }) as string}
                    </th>
                    <th style={{ textTransform: "uppercase", fontSize: 11 }}>
                      {t("employees.team.col.section", {
                        defaultValue: "Section",
                      }) as string}
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((m) => (
                <tr key={m.id}>
                  <td className="mono text-sm">{m.employee_code}</td>
                  <td className="text-sm" style={{ fontWeight: 500 }}>
                    {m.full_name}
                  </td>
                  <td className="text-sm">{m.designation ?? "—"}</td>
                  {showTiers && (
                    <>
                      <td className="text-sm text-dim">
                        {m.division_name ?? "—"}
                      </td>
                      <td className="text-sm text-dim">
                        {m.department_name ?? "—"}
                      </td>
                      <td className="text-sm text-dim">
                        {m.section_name ?? "—"}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DetailsTab({
  employee,
  photos,
}: {
  employee: Employee;
  photos: Photo[];
}) {
  const { t } = useTranslation();
  const [zoomPhotoId, setZoomPhotoId] = useState<number | null>(null);
  const role = primaryRoleFromCodes(employee.role_codes ?? []);

  // Esc closes the photo lightbox specifically. Scoped to when the
  // lightbox is open + capture phase so it dismisses cleanly without
  // bubbling into the drawer's focus-trap handler.
  useEffect(() => {
    if (zoomPhotoId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setZoomPhotoId(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [zoomPhotoId]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Section label={t("employees.section.identity") as string}>
        <Row label={t("employees.field.code") as string}>
          <span className="mono">{employee.employee_code}</span>
        </Row>
        <Row label={t("employees.field.fullName") as string}>
          {employee.full_name}
        </Row>
        <Row label={t("employees.field.designation") as string}>
          {employee.designation ?? "—"}
        </Row>
        <Row label={t("employees.field.email") as string}>
          {employee.email ?? "—"}
        </Row>
        <Row label={t("employees.field.phone") as string}>
          {employee.phone ?? "—"}
        </Row>
      </Section>

      <Section label={t("employees.section.assignment") as string}>
        <Row label={t("employees.field.division") as string}>
          {employee.division ? (
            <>
              {employee.division.name}{" "}
              <span className="mono text-xs text-dim">
                ({employee.division.code})
              </span>
            </>
          ) : (
            <span className="text-xs text-dim">—</span>
          )}
        </Row>
        <Row label={t("employees.field.department") as string}>
          {employee.department.name}{" "}
          <span className="mono text-xs text-dim">
            ({employee.department.code})
          </span>
        </Row>
        <Row label={t("employees.field.section") as string}>
          {employee.section ? (
            <>
              {employee.section.name}{" "}
              <span className="mono text-xs text-dim">
                ({employee.section.code})
              </span>
            </>
          ) : (
            <span className="text-xs text-dim">—</span>
          )}
        </Row>
        <Row label={t("employees.field.reportsTo") as string}>
          {employee.reports_to_full_name ?? "—"}
        </Row>
        <Row label={t("employees.col.role") as string}>
          {role ? (
            <span className={`pill ${rolePillClass(role)}`}>
              {t(`role.${role}`, { defaultValue: role }) as string}
            </span>
          ) : (
            <span className="text-xs text-dim">—</span>
          )}
        </Row>
      </Section>

      <Section label={t("employees.section.lifecycle") as string}>
        <Row label={t("employees.field.joinDate") as string}>
          {employee.joining_date ?? "—"}
        </Row>
        <Row label={t("employees.field.relievingDate") as string}>
          {employee.relieving_date ?? "—"}
        </Row>
        <Row label={t("employees.field.deactivatedAt") as string}>
          {employee.deactivated_at
            ? new Date(employee.deactivated_at).toLocaleString()
            : "—"}
        </Row>
      </Section>

      <Section label={t("employees.section.referencePhotos") as string}>
        <Row label={t("employees.col.photos") as string}>
          <span
            className={`pill ${photos.length > 0 ? "pill-accent" : "pill-neutral"}`}
          >
            {photos.length}
          </span>
        </Row>
      </Section>
      {photos.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
            gap: 8,
            marginTop: -4,
          }}
        >
          {photos.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setZoomPhotoId(p.id)}
              title={t(`employees.photos.angles.${p.angle}`, {
                defaultValue: p.angle,
              }) as string}
              style={{
                position: "relative",
                padding: 0,
                border: "1px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
                background: "var(--bg-sunken)",
                cursor: "zoom-in",
                aspectRatio: "1 / 1",
              }}
            >
              <img
                src={`/api/employees/${employee.id}/photos/${p.id}/image`}
                alt={p.angle}
                style={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
              <span
                className="text-xs mono"
                style={{
                  position: "absolute",
                  bottom: 0,
                  insetInlineStart: 0,
                  padding: "1px 6px",
                  background: "rgba(0,0,0,0.55)",
                  color: "white",
                  fontSize: 10,
                  borderTopRightRadius: 6,
                }}
              >
                {p.angle}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Lightbox — clicking a thumbnail opens this; X button or Esc
          dismisses. z-index has to clear the design CSS's sticky
          topbar (10000) and toast container (99999), and the close
          button is anchored to the fixed overlay itself (not the
          inner image wrapper) so it always renders at the top-right
          of the viewport regardless of image dimensions. */}
      {zoomPhotoId !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo preview"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "grid",
            placeItems: "center",
            zIndex: 100000,
            padding: 32,
          }}
        >
          <button
            type="button"
            onClick={() => setZoomPhotoId(null)}
            aria-label={t("common.close") as string}
            title={(t("common.close") as string) + " (Esc)"}
            autoFocus
            style={{
              position: "fixed",
              top: 24,
              insetInlineEnd: 24,
              zIndex: 100001,
              width: 44,
              height: 44,
              borderRadius: 999,
              border: "2px solid rgba(255,255,255,0.85)",
              background: "rgba(0,0,0,0.85)",
              color: "white",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "auto",
              padding: 0,
              fontFamily: "inherit",
              boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
            }}
          >
            <Icon name="x" size={20} />
          </button>
          <img
            src={`/api/employees/${employee.id}/photos/${zoomPhotoId}/image`}
            alt="Reference photo"
            style={{
              maxWidth: "90vw",
              maxHeight: "90vh",
              objectFit: "contain",
              borderRadius: 8,
              boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
        </div>
      )}

      <Section label={t("employees.section.status") as string}>
        <Row label={t("employees.col.status") as string}>
          <span
            className={`pill ${
              employee.status === "active" ? "pill-success" : "pill-warning"
            }`}
          >
            {t(`employees.statusValue.${employee.status}`) as string}
          </span>
        </Row>
      </Section>
    </div>
  );
}

function EventsTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  // Defaults to today's local date in YYYY-MM-DD; operator can flip
  // to any past date or clear the filter (use "All dates" toggle).
  const [date, setDate] = useState<string>(todayLocalIso());
  const [allDates, setAllDates] = useState<boolean>(false);
  const [lightboxEventId, setLightboxEventId] = useState<number | null>(null);
  const PAGE_SIZE = 25;

  // Day-bounded range — captured_at is stored in UTC so we convert
  // the operator's local picked date to a UTC ISO range covering the
  // full local day. Null when "All dates" is on.
  const { start, end } = computeDayRange(allDates ? null : date);

  // Reset to page 1 when the date filter changes.
  // (Don't memoise the start/end recompute — it's a few string ops
  // per render, cheap.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useDateChangeReset(date, allDates, () => setPage(1));

  const events = useDetectionEvents({
    camera_id: null,
    employee_id: employeeId,
    identified: null,
    start,
    end,
    page,
    page_size: PAGE_SIZE,
  });

  const totalPages = events.data
    ? Math.max(1, Math.ceil(events.data.total / events.data.page_size))
    : 1;

  return (
    <div>
      {/* Date filter row — default = today, "All dates" reverts to
          the unbounded query. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <label
          className="text-xs text-dim"
          style={{ fontWeight: 500 }}
        >
          {t("employees.events.dateLabel") as string}
        </label>
        <DatePicker
          value={date}
          disabled={allDates}
          onChange={(next) => setDate(next || todayLocalIso())}
          max={todayIso()}
          ariaLabel={t("employees.events.dateLabel") as string}
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={allDates}
            onChange={(e) => setAllDates(e.target.checked)}
          />
          {t("employees.events.allDates") as string}
        </label>
        {!allDates && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setDate(todayLocalIso())}
            disabled={date === todayLocalIso()}
            title={t("employees.events.resetToToday") as string}
          >
            {t("employees.events.today") as string}
          </button>
        )}
      </div>

      {events.isLoading && (
        <div className="text-sm text-dim">
          {t("common.loading") as string}…
        </div>
      )}
      {events.isError && (
        <div className="text-sm" style={{ color: "var(--danger-text)" }}>
          {t("employees.events.loadFailed") as string}
        </div>
      )}
      {events.data && events.data.items.length === 0 && (
        <div className="text-sm text-dim" style={{ padding: 12 }}>
          {allDates
            ? (t("employees.events.empty") as string)
            : (t("employees.events.emptyForDate") as string)}
        </div>
      )}

      {events.data && events.data.items.length > 0 && (
        <>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-secondary)",
          marginBottom: 8,
        }}
      >
        {t("employees.events.totalLabel", {
          count: events.data?.total ?? 0,
        }) as string}
      </div>
      <AnomalyInfoBanner message="If the camera misses certain events due to camera positioning, capture limitations, lighting, or brightness conditions, those cases should be treated as possible anomalies." />

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 64 }}>{t("liveCapture.col.face") as string}</th>
            <th>{t("liveCapture.col.time") as string}</th>
            <th>{t("liveCapture.col.camera") as string}</th>
            <th>{t("liveCapture.col.confidence") as string}</th>
          </tr>
        </thead>
        <tbody>
          {(events.data?.items ?? []).map((ev: DetectionEvent) => (
            <tr key={ev.id}>
              <td>
                {ev.has_crop ? (
                  <button
                    type="button"
                    onClick={() => setLightboxEventId(ev.id)}
                    aria-label={`Preview face crop for event ${ev.id}`}
                    style={{
                      display: "block",
                      width: 44,
                      height: 44,
                      padding: 0,
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      overflow: "hidden",
                      cursor: "pointer",
                      background: "var(--bg-sunken)",
                      transition: "transform 120ms ease, box-shadow 120ms ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "scale(1.08)";
                      e.currentTarget.style.boxShadow = "0 3px 10px rgba(0,0,0,0.25)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                  >
                    <img
                      src={`/api/detection-events/${ev.id}/crop`}
                      alt={`event ${ev.id}`}
                      loading="lazy"
                      style={{
                        display: "block",
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        pointerEvents: "none",
                      }}
                    />
                  </button>
                ) : (
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: "var(--radius-sm)",
                      border: "1px dashed var(--border)",
                      background: "var(--bg-sunken)",
                    }}
                    title="No crop"
                  />
                )}
              </td>
              <td className="text-sm">
                <RelativeTime iso={ev.captured_at} />
              </td>
              <td className="text-sm">{ev.camera_name}</td>
              <td className="mono text-sm">
                {ev.confidence !== null
                  ? `${(ev.confidence * 100).toFixed(0)}%`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pagination */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 10,
          fontSize: 12,
        }}
      >
        <span className="text-dim">
          {t("employees.events.pageNumber", {
            page,
            totalPages,
          }) as string}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="btn btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <Icon name="chevronLeft" size={11} />
            {t("common.previous") as string}
          </button>
          <button
            className="btn btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            {t("common.next") as string}
            <Icon name="chevronRight" size={11} />
          </button>
        </div>
      </div>
        </>
      )}

      {/* Face crop lightbox — opens when a thumbnail is clicked */}
      {lightboxEventId !== null && (() => {
        const allEvents = events.data?.items ?? [];
        const croppedEvents = allEvents.filter((e) => e.has_crop);
        const idx = croppedEvents.findIndex((e) => e.id === lightboxEventId);
        if (idx === -1) return null;
        return (
          <DetectionEventLightbox
            events={croppedEvents}
            initialIndex={idx}
            onClose={() => setLightboxEventId(null)}
          />
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matched Clips tab
//
// Lists every person_clip where the employee is matched — either by the
// legacy ``person_clips.employee_id`` link or by appearing in the
// per-UC ``matched_employees`` JSONB array. Server filter:
// ``?matched_employee_id=N`` (union semantics, see repository.py).
//
// Each card renders the clip thumbnail (``/api/person-clips/{id}/thumbnail``)
// + camera name + duration + size + processed-UC chips. Click → opens the
// same ``ClipDetailDrawer`` used by Person Clips + Clip Analytics.
// ---------------------------------------------------------------------------

const MATCHED_CLIPS_PAGE_SIZE = 24;

function MatchedClipsTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  // Same date pattern as EventsTab — defaults to today's local date;
  // operator can flip to any past date or clear via "All dates".
  const [date, setDate] = useState<string>(todayLocalIso());
  const [allDates, setAllDates] = useState<boolean>(false);
  const [openClip, setOpenClip] = useState<PersonClipOut | null>(null);

  // Convert the local YYYY-MM-DD to a UTC ISO range covering the full
  // local day. Same helper EventsTab uses.
  const { start, end } = computeDayRange(allDates ? null : date);

  // Reset paging when the date filter changes so the operator doesn't
  // land on an empty page after narrowing.
  useDateChangeReset(date, allDates, () => setPage(1));

  const qs = (() => {
    const p = new URLSearchParams();
    p.set("matched_employee_id", String(employeeId));
    p.set("page", String(page));
    p.set("page_size", String(MATCHED_CLIPS_PAGE_SIZE));
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    return p.toString();
  })();

  const list = useQuery({
    queryKey: ["matched-clips", employeeId, qs],
    queryFn: () => api<PersonClipListResponse>(`/api/person-clips?${qs}`),
    refetchInterval: 30_000,
    // Don't burn the 30 s polling budget retrying permission /
    // not-found failures — those won't change between polls.
    retry: (failureCount, error) => {
      if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403 || error.status === 404) {
          return false;
        }
      }
      return failureCount < 2;
    },
  });

  const errorMessage = (() => {
    if (!list.isError) return null;
    const err = list.error;
    if (err instanceof ApiError) {
      if (err.status === 401) {
        return "Your session expired. Sign in again to view matched clips.";
      }
      if (err.status === 403) {
        return "Matched clips are available to Admin and HR roles.";
      }
      if (err.status === 400) {
        return "Invalid date range. Try clearing the filter.";
      }
      if (err.status >= 500) {
        return "Could not load matched clips — the server is still warming up. The page will retry automatically.";
      }
      return `Could not load matched clips (HTTP ${err.status}).`;
    }
    return "Could not load matched clips. Check your connection and try again.";
  })();

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / MATCHED_CLIPS_PAGE_SIZE));

  return (
    <>
      {/* Date filter row — identical pattern to EventsTab so operators
          get the same affordances across both tabs. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <label className="text-xs text-dim" style={{ fontWeight: 500 }}>
          {t("employees.events.dateLabel") as string}
        </label>
        <DatePicker
          value={date}
          disabled={allDates}
          onChange={(next) => setDate(next || todayLocalIso())}
          max={todayIso()}
          ariaLabel={t("employees.events.dateLabel") as string}
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={allDates}
            onChange={(e) => setAllDates(e.target.checked)}
          />
          {t("employees.events.allDates") as string}
        </label>
        {!allDates && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setDate(todayLocalIso())}
            disabled={date === todayLocalIso()}
            title={t("employees.events.resetToToday") as string}
          >
            {t("employees.events.today") as string}
          </button>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div className="text-xs text-dim">
          {list.isLoading
            ? "Loading…"
            : `${total} clip${total === 1 ? "" : "s"} where this person was matched`}
        </div>
        {totalPages > 1 && (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1 || list.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <Icon name="chevronLeft" size={11} />
            </button>
            <span
              className="mono text-xs text-dim"
              style={{ alignSelf: "center" }}
            >
              {page} / {totalPages}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= totalPages || list.isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              <Icon name="chevronRight" size={11} />
            </button>
          </div>
        )}
      </div>

      {list.isLoading && (
        <div className="text-sm text-dim" style={{ padding: 16 }}>
          Loading clips…
        </div>
      )}
      {errorMessage && (
        <div
          className="text-sm"
          style={{ padding: 16, color: "var(--danger-text)" }}
        >
          {errorMessage}
        </div>
      )}
      {!list.isLoading && !list.isError && items.length === 0 && (
        <div
          className="text-sm text-dim"
          style={{
            padding: 24,
            border: "1px dashed var(--border)",
            borderRadius: "var(--radius-sm)",
            textAlign: "center",
          }}
        >
          No matched clips yet. When this person is identified in a clip
          (via UC1 / UC2 / UC3 on the Clip Analytics page), it'll show
          up here.
        </div>
      )}

      {items.length > 0 && (
        <>
          <AnomalyInfoBanner message="If the camera misses certain events due to camera positioning, capture limitations, lighting, or brightness conditions, those cases should be treated as possible anomalies." />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
          {items.map((c) => (
            <MatchedClipCard
              key={c.id}
              clip={c}
              onOpen={() => {
                // Only completed clips have a stable artifact — the
                // detail drawer's video + face-crop panels would 404
                // for an in-flight encode. Match the gating Clip
                // Analytics already applies.
                if (c.recording_status === "completed") setOpenClip(c);
              }}
            />
          ))}
        </div>
        </>
      )}

      {openClip && (
        <ClipDetailDrawer
          clip={openClip}
          onClose={() => setOpenClip(null)}
          focusEmployeeId={employeeId}
        />
      )}
    </>
  );
}

function MatchedClipCard({
  clip,
  onOpen,
}: {
  clip: PersonClipOut;
  onOpen: () => void;
}) {
  const [thumbError, setThumbError] = useState(false);
  const playable = clip.recording_status === "completed";
  // Prefer the matched employee's face crop when the API returned one
  // (populated by the list endpoint when called with ?matched_employee_id=N).
  // Fall back to the full clip thumbnail for completed clips.
  const imgSrc =
    clip.matched_face_crop_id != null
      ? `/api/person-clips/${clip.id}/face-crops/${clip.matched_face_crop_id}/image`
      : playable
        ? `/api/person-clips/${clip.id}/thumbnail`
        : null;

  // Reset sticky error state whenever the image source changes so a
  // 404 caught while the clip was still encoding doesn't prevent the
  // thumbnail from appearing once encoding completes.
  useEffect(() => {
    setThumbError(false);
  }, [imgSrc]);

  return (
    <button
      type="button"
      onClick={playable ? onOpen : undefined}
      title={
        playable
          ? "Open clip details"
          : `Details unavailable while clip is ${clip.recording_status}`
      }
      style={{
        textAlign: "start",
        padding: 0,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        cursor: playable ? "pointer" : "not-allowed",
        display: "flex",
        flexDirection: "column",
        transition: "transform 120ms ease, box-shadow 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (!playable) return;
        e.currentTarget.style.boxShadow = "0 6px 16px rgba(0,0,0,0.12)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "";
        e.currentTarget.style.transform = "";
      }}
    >
      {/* Thumbnail */}
      <div
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          background: "#111",
          overflow: "hidden",
        }}
      >
        {!thumbError && imgSrc ? (
          <img
            src={imgSrc}
            alt=""
            onError={() => setThumbError(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "grid",
              placeItems: "center",
              color: "rgba(255,255,255,0.4)",
            }}
          >
            <Icon name="videocam" size={28} />
          </div>
        )}

        {/* Lifecycle pill (top-left). Recording / Encoding land as
            colour-coded chips; Completed shows nothing — we don't
            want every card carrying a green badge. */}
        {clip.recording_status === "recording" && (
          <LifecyclePill bg="rgba(239,68,68,0.92)">🔴 Recording</LifecyclePill>
        )}
        {clip.recording_status === "finalizing" && (
          <LifecyclePill bg="rgba(245,158,11,0.92)">Encoding</LifecyclePill>
        )}

        {/* Duration (bottom-right). */}
        <div
          className="mono"
          style={{
            position: "absolute",
            insetInlineEnd: 6,
            insetBlockEnd: 6,
            padding: "2px 6px",
            background: "rgba(0,0,0,0.65)",
            color: "#fff",
            fontSize: 11,
            borderRadius: 4,
          }}
        >
          {fmtClipDuration(clip.duration_seconds)}
        </div>
      </div>

      {/* Meta footer */}
      <div
        style={{
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={clip.camera_name}
        >
          {clip.camera_name || "Unknown camera"}
        </div>
        <div
          className="text-xs text-dim"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={clip.clip_name}
        >
          {fmtClipTime(clip.clip_start)} · {fmtClipSize(clip.filesize_bytes)}
        </div>

        {/* Processed-UC chips. Only show when at least one UC has run
            — keeps the card quiet for raw Saved clips. */}
        {clip.processed_use_cases.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
            {clip.processed_use_cases.map((uc) => (
              <span
                key={uc}
                className="mono"
                style={{
                  padding: "1px 6px",
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 700,
                  background: ucAccentSoft(uc),
                  color: ucAccentText(uc),
                  border: `1px solid ${ucAccentBorder(uc)}`,
                }}
              >
                {uc.toUpperCase()}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function LifecyclePill({
  bg,
  children,
}: {
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        position: "absolute",
        top: 6,
        insetInlineStart: 6,
        padding: "2px 8px",
        background: bg,
        color: "#fff",
        fontSize: 10.5,
        fontWeight: 700,
        borderRadius: 999,
      }}
    >
      {children}
    </span>
  );
}

function fmtClipDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtClipSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtClipTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  } catch {
    return iso;
  }
}

function ucAccentSoft(uc: string): string {
  switch (uc.toLowerCase()) {
    case "uc1":
      return "rgba(59,130,246,0.12)";
    case "uc2":
      return "rgba(139,92,246,0.12)";
    case "uc3":
      return "rgba(16,185,129,0.12)";
    default:
      return "var(--bg-sunken)";
  }
}

function ucAccentText(uc: string): string {
  switch (uc.toLowerCase()) {
    case "uc1":
      return "#1d4ed8";
    case "uc2":
      return "#6d28d9";
    case "uc3":
      return "#047857";
    default:
      return "var(--text-secondary)";
  }
}

function ucAccentBorder(uc: string): string {
  switch (uc.toLowerCase()) {
    case "uc1":
      return "rgba(59,130,246,0.25)";
    case "uc2":
      return "rgba(139,92,246,0.25)";
    case "uc3":
      return "rgba(16,185,129,0.25)";
    default:
      return "var(--border)";
  }
}

/**
 * Attendance tab — renders the exact same DayDetailContent used by the
 * Attendance Calendar → Per Person → Day Detail view. Date picker on top
 * lets the user navigate days; the body is 100 % identical to the calendar.
 */
function AttendanceTab({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const [date, setDate] = useState<string>(todayLocalIso());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Date picker */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <label className="text-xs text-dim" style={{ fontWeight: 500 }}>
          {t("employees.events.dateLabel") as string}
        </label>
        <DatePicker
          value={date}
          onChange={(next) => setDate(next || todayLocalIso())}
          max={todayIso()}
          ariaLabel={t("employees.events.dateLabel") as string}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setDate(todayLocalIso())}
          disabled={date === todayLocalIso()}
        >
          {t("employees.events.today") as string}
        </button>
      </div>

      {/* Exact same content as Calendar → Day Detail — shared component */}
      <DayDetailContent employeeId={employeeId} isoDate={date} />
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-tertiary)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "150px 1fr",
          rowGap: 6,
          columnGap: 12,
          fontSize: 13,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="text-xs text-dim" style={{ paddingTop: 2 }}>
        {label}
      </div>
      <div>{children}</div>
    </>
  );
}

function primaryRoleFromCodes(codes: string[]): string | null {
  const order = ["Admin", "HR", "Manager", "Employee"];
  for (const r of order) if (codes.includes(r)) return r;
  return codes[0] ?? null;
}

function rolePillClass(role: string): string {
  switch (role) {
    case "Admin":
      return "pill-danger";
    case "HR":
      return "pill-accent";
    case "Manager":
      return "pill-warning";
    default:
      return "pill-neutral";
  }
}

/** Today's date in local time as YYYY-MM-DD. Used as the events
 *  tab's default date filter — operator can pick any earlier date or
 *  toggle "All dates" to drop the bound. */
function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Convert a YYYY-MM-DD local date to a UTC ISO range covering the
 *  full local day. captured_at is stored in UTC, so the range needs
 *  to span the operator's local day in UTC terms. Null date ⇒ no
 *  bound (used by the "All dates" toggle). */
function computeDayRange(date: string | null): {
  start: string | null;
  end: string | null;
} {
  if (!date) return { start: null, end: null };
  const [y, m, d] = date.split("-").map((s) => Number(s));
  if (!y || !m || !d) return { start: null, end: null };
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0);
  const endLocal = new Date(y, m - 1, d, 23, 59, 59, 999);
  return {
    start: startLocal.toISOString(),
    end: endLocal.toISOString(),
  };
}

/** Reset paging to 1 whenever the date filter (or all-dates flag)
 *  changes. Wrapped in a hook so the events tab body stays
 *  declarative and the dep array is correct. */
function useDateChangeReset(
  date: string,
  allDates: boolean,
  reset: () => void,
): void {
  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, allDates]);
}

// ---------------------------------------------------------------------------
// Detection Event lightbox — split panel (image left, metadata right).
// Same visual design as the Clip Analytics FaceCropLightbox.
// ---------------------------------------------------------------------------

function DetectionEventLightbox({
  events,
  initialIndex,
  onClose,
}: {
  events: DetectionEvent[];
  initialIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const total = events.length;
  const ev = events[index]!;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIndex((i) => (i - 1 + total) % total);
      if (e.key === "ArrowRight") setIndex((i) => (i + 1) % total);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, total]);

  const detTime = (() => {
    try {
      return new Date(ev.captured_at).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return ev.captured_at;
    }
  })();

  const detDate = (() => {
    try {
      return new Date(ev.captured_at).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    } catch {
      return "";
    }
  })();

  const confidencePct =
    ev.confidence != null
      ? `${(ev.confidence * 100).toFixed(1)}%`
      : "—";

  const detectorMode =
    ev.detection_metadata?.detector_mode ?? "—";

  // Portal out of `.drawer` (which has position:fixed and therefore acts
  // as a containing block for fixed-position children).  Without the
  // portal `inset:0` resolves to the 540 px drawer, not the viewport.
  const portalTarget =
    typeof document !== "undefined"
      ? (document.getElementById("drawer-root") ?? document.body)
      : null;

  const modal = (
    /* Translucent overlay — clicking outside closes */
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Face crop preview"
      style={{
        position: "fixed", inset: 0, zIndex: 100000,
        background: "rgba(0,0,0,0.72)",
        display: "grid", placeItems: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      {/* Centred popup card */}
      <div
        style={{
          display: "flex",
          width: "min(820px, 95vw)",
          maxHeight: "88vh",
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 32px 80px rgba(0,0,0,0.55)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: dark image pane */}
        <div
          style={{
            flex: 1, minWidth: 0, background: "#0d0d0d",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            position: "relative", padding: "40px 36px",
          }}
        >
          <img
            key={ev.id}
            src={`/api/detection-events/${ev.id}/crop`}
            alt={ev.employee_name ?? `Event ${ev.id}`}
            style={{
              maxWidth: "100%", maxHeight: "46vh",
              width: "auto", height: "auto",
              objectFit: "contain", borderRadius: 10,
              boxShadow: "0 8px 32px rgba(0,0,0,0.6)", display: "block",
            }}
          />
          {total > 1 && (
            <>
              <button type="button" onClick={() => setIndex((i) => (i - 1 + total) % total)} aria-label="Previous"
                style={{ position: "absolute", insetInlineStart: 12, top: "50%", transform: "translateY(-50%)", width: 36, height: 36, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.5)", color: "#fff", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 16 }}>‹</button>
              <button type="button" onClick={() => setIndex((i) => (i + 1) % total)} aria-label="Next"
                style={{ position: "absolute", insetInlineEnd: 12, top: "50%", transform: "translateY(-50%)", width: 36, height: 36, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.5)", color: "#fff", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 16 }}>›</button>
            </>
          )}
          <div className="mono" style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.5)", color: "rgba(255,255,255,0.8)", padding: "3px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
            {index + 1} / {total}
          </div>
        </div>

        {/* Right: metadata pane */}
        <div style={{ width: 300, flexShrink: 0, background: "var(--bg)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "12px 14px 10px", display: "flex", alignItems: "center", gap: 6, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <span className="pill pill-neutral" style={{ fontSize: 10.5, fontWeight: 700 }}>{ev.camera_name}</span>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={onClose} aria-label="Close preview" style={{ width: 26, height: 26, borderRadius: "50%", border: "1px solid var(--border)", background: "transparent", cursor: "pointer", display: "grid", placeItems: "center", color: "var(--text)" }}>
              <Icon name="x" size={12} />
            </button>
          </div>

          {/* Identity + confidence */}
          <div style={{ padding: "12px 14px 0", flexShrink: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", lineHeight: 1.2, marginBottom: 3 }}>
              {ev.employee_name ?? ev.former_match_employee_name ?? "Unknown"}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: ev.confidence != null ? 12 : 4, color: ev.employee_id ? "var(--success-text)" : ev.former_employee_match ? "var(--warning-text)" : "var(--text-secondary)" }}>
              {ev.employee_id ? "● Matched" : ev.former_employee_match ? "⚠ Former employee" : "○ Unmatched"}
            </div>
            {ev.confidence != null && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4 }}>
                  <span>Match confidence</span>
                  <span className="mono" style={{ fontWeight: 600 }}>{confidencePct}</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, ev.confidence * 100)}%`, background: "var(--accent)", borderRadius: 2 }} />
                </div>
              </div>
            )}
          </div>

          {/* Metadata grid */}
          <div style={{ padding: "0 14px 14px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, overflowY: "auto", flex: 1 }}>
            <DetEventMetaCard label="DETECTION TIME" value={detTime} />
            <DetEventMetaCard label="DETECTION DATE" value={detDate} />
            <DetEventMetaCard label="CAMERA" value={ev.camera_name} />
            <DetEventMetaCard label="MATCH CONFIDENCE" value={confidencePct} />
            <DetEventMetaCard label="DETECTOR" value={detectorMode} />
            <DetEventMetaCard label="EVENT ID" value={`#${ev.id}`} />
          </div>

          {/* Navigation hint */}
          <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0 }}>
            ← → to navigate · Esc to close
          </div>
        </div>
      </div>
    </div>
  );

  return portalTarget ? createPortal(modal, portalTarget) : modal;
}

function DetEventMetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        background: "var(--bg-elev)",
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-tertiary)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}
