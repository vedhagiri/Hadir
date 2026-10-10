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
// Tab bodies live in employeeProfileTabs.tsx (shared with the
// full-page profile at /employees/:id). This drawer is still used by
// My Team.
//
// Edit is intentionally NOT inline here — operators flip to the Edit
// drawer via the row's kebab menu (or the "Edit" button in this
// drawer's footer) so the read-only / write-mode boundary is
// explicit.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMe } from "../../auth/AuthProvider";
import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { DrawerTabs, LoadErrorPanel } from "./peopleUi";
import {
  AttendanceTab,
  DetailsTab,
  EventsTab,
  MatchedClipsTab,
  TeamMembersTab,
} from "./employeeProfileTabs";
import { useEmployeeDetail, useEmployeePhotos } from "./hooks";
import { SkeletonLines } from "../../components/Skeleton";

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
          <div className="pp-drawer-head-main">
            <div className="pp-drawer-eyebrow">
              {t("employees.view.label") as string}
            </div>
            <div className="pp-drawer-title">
              {detail.data?.full_name ?? "—"}
            </div>
            {detail.data && (
              <div className="pp-drawer-meta">
                <span className="mono">{detail.data.employee_code}</span> · {detail.data.department.name}
              </div>
            )}
          </div>
          <div className="pp-drawer-head-actions">
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

        <DrawerTabs<Tab>
          label={t("employees.view.tabs") as string}
          value={tab}
          onChange={setTab}
          tabs={(["details", "attendance", "events", "clips", "team"] as Tab[]).map((key) => ({
            key,
            label: t(`employees.view.tab.${key}`) as string,
          }))}
        />

        <div className="drawer-body">
          {tab === "details" &&
            (detail.isLoading ? (
              <SkeletonLines lines={5} />
            ) : detail.data ? (
              <DetailsTab
                employee={detail.data}
                photos={photos.data?.items ?? []}
              />
            ) : (
              <LoadErrorPanel
                title={t("employees.loadFailed") as string}
                onRetry={() => void detail.refetch()}
              />
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

