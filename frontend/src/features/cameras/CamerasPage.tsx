// Cameras list page — Admin only.
// Layout mirrors the design's page-header + card-wrapped table pattern.
// Per-row actions live in a vertical-3-dot kebab menu (Preview / Edit
// / Delete). Delete opens a confirmation modal before firing.
// The RTSP URL never appears in the UI — we show ``rtsp_host`` only.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { BrandLogo } from "./BrandLogo";
import { CameraDrawer } from "./CameraDrawer";
import { CameraImportModal } from "./CameraImportModal";
import { PreviewModal } from "./PreviewModal";
import {
  exportCameras,
  useBulkUpdateCameras,
  useCameras,
  useDeleteCamera,
  usePatchCamera,
} from "./hooks";
import { useWorkers } from "../operations/hooks";
import type { WorkerStats } from "../operations/types";
import type { Camera } from "./types";

// The four bulk-toggleable settings, in display order. The value is the
// i18n key suffix under ``cameras.bulk.*`` for the setting's label.
const BULK_FIELDS = {
  worker_enabled: "worker",
  display_enabled: "display",
  detection_enabled: "detection",
  clip_recording_enabled: "clipSaving",
  live_matching_enabled: "matching",
} as const;

export function CamerasPage() {
  const { t } = useTranslation();
  const list = useCameras();
  const workers = useWorkers();
  const del = useDeleteCamera();
  const patch = usePatchCamera();
  const bulk = useBulkUpdateCameras();

  // Bulk JSON import/export state.
  const [showImport, setShowImport] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkApplied, setBulkApplied] = useState<number | null>(null);

  // Camera-id → worker payload, used by StatusDot so the pill reflects
  // the same real-time state the Worker Monitoring page shows
  // (status + RTSP stage), not the stale ``last_seen_at`` heuristic.
  const workerByCamera: Record<number, WorkerStats> = {};
  workers.data?.workers.forEach((w) => {
    workerByCamera[w.camera_id] = w;
  });
  const [drawerMode, setDrawerMode] = useState<"create" | "edit" | null>(null);
  const [editTarget, setEditTarget] = useState<Camera | null>(null);
  const [previewTarget, setPreviewTarget] = useState<Camera | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Camera | null>(null);

  const items = list.data?.items ?? [];
  const allIds = items.map((c) => c.id);
  // Count only ids that are still present in the current list — the list
  // can change under us (poll / CRUD) and stale ids must not inflate counts.
  const selectedIds = allIds.filter((id) => selected.has(id));
  const selectedCount = selectedIds.length;
  const allSelected = allIds.length > 0 && selectedCount === allIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  // Indeterminate is a DOM-only property — set it imperatively on the header
  // checkbox whenever the selection straddles "some but not all".
  const headerCheckRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (headerCheckRef.current) {
      headerCheckRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  // Drop any selected ids that no longer exist in the list (camera deleted,
  // tenant switch, etc.) so the bulk bar count never references stale rows.
  useEffect(() => {
    setSelected((prev) => {
      const present = new Set(allIds);
      let changed = false;
      const next = new Set<number>();
      prev.forEach((id) => {
        if (present.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
    // allIds identity changes every render; key on its joined signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allIds.join(",")]);

  const clearSelection = () => setSelected(new Set());

  const applyBulk = (field: keyof typeof BULK_FIELDS, value: boolean) => {
    if (selectedIds.length === 0) return;
    setBulkError(null);
    setBulkApplied(null);
    bulk.mutate(
      { camera_ids: selectedIds, [field]: value },
      {
        onSuccess: (res) => {
          setBulkApplied(res.updated);
          clearSelection();
        },
        onError: (e) => {
          setBulkError(extractApiError(e, t("cameras.bulk.failed")));
        },
      },
    );
  };

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allIds));
  };

  const doExport = async () => {
    setExportError(null);
    setExporting(true);
    try {
      const ids = selected.size > 0 ? [...selected] : undefined;
      const data = await exportCameras(ids);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = data.exported_at ? data.exported_at.slice(0, 10) : "all";
      a.download = `cameras-export-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(extractApiError(e, "Export failed."));
    } finally {
      setExporting(false);
    }
  };

  const openAdd = () => {
    setEditTarget(null);
    setDrawerMode("create");
  };
  const openEdit = (cam: Camera) => {
    setEditTarget(cam);
    setDrawerMode("edit");
  };
  const closeDrawer = () => {
    setDrawerMode(null);
    setEditTarget(null);
  };

  const toggleWorkerEnabled = (cam: Camera) => {
    patch.mutate({
      id: cam.id,
      patch: { worker_enabled: !cam.worker_enabled },
    });
  };
  const toggleDisplayEnabled = (cam: Camera) => {
    patch.mutate({
      id: cam.id,
      patch: { display_enabled: !cam.display_enabled },
    });
  };
  const toggleDetectionEnabled = (cam: Camera) => {
    patch.mutate({
      id: cam.id,
      patch: { detection_enabled: !cam.detection_enabled },
    });
  };
  const toggleClipRecordingEnabled = (cam: Camera) => {
    patch.mutate({
      id: cam.id,
      patch: { clip_recording_enabled: !cam.clip_recording_enabled },
    });
  };
  const toggleMatchingEnabled = (cam: Camera) => {
    // Auto-gate: matching only runs with detection on. Guard here too
    // so a programmatic call can't enable it on a detection-off camera.
    if (!cam.detection_enabled) return;
    patch.mutate({
      id: cam.id,
      patch: { live_matching_enabled: !cam.live_matching_enabled },
    });
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("cameras.page.title")}</h1>
          <p className="page-sub">
            {list.data
              ? t("cameras.page.sub", { count: list.data.items.length })
              : "—"}
            {" "}{t("cameras.page.subSuffix")}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={doExport}
            disabled={exporting || items.length === 0}
            title={
              selected.size > 0
                ? t("cameras.page.exportTitleSelected", { n: selected.size })
                : t("cameras.page.exportTitleAll")
            }
          >
            <Icon name="download" size={12} />
            {exporting
              ? t("cameras.page.exporting")
              : selected.size > 0
                ? t("cameras.page.exportSelected", { n: selected.size })
                : t("cameras.page.exportAll")}
          </button>
          <button className="btn" onClick={() => setShowImport(true)}>
            <Icon name="upload" size={12} />
            {t("cameras.page.import")}
          </button>
          <button className="btn btn-primary" onClick={openAdd}>
            <Icon name="plus" size={12} />
            {t("cameras.page.addCamera")}
          </button>
        </div>
      </div>

      {exportError && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            marginBottom: 12,
          }}
        >
          {exportError}
        </div>
      )}

      {bulkError && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            marginBottom: 12,
          }}
        >
          {bulkError}
        </div>
      )}

      {bulkApplied !== null && selectedCount === 0 && (
        <div
          role="status"
          style={{
            background: "var(--success-soft, var(--bg-sunken))",
            color: "var(--text)",
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            marginBottom: 12,
          }}
        >
          {t("cameras.bulk.applied", { count: bulkApplied })}
        </div>
      )}

      {selectedCount > 0 && (
        <BulkActionBar
          count={selectedCount}
          busy={bulk.isPending}
          onApply={applyBulk}
          onClear={clearSelection}
        />
      )}

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">{t("cameras.page.allCameras")}</h3>
          <div className="text-xs text-dim">
            {t("cameras.page.rtspNotice")}
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  ref={headerCheckRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={t("cameras.page.selectAllAria")}
                  title={t("cameras.page.selectAllTitle")}
                  disabled={items.length === 0}
                />
              </th>
              <th style={{ width: 96 }}>{t("cameras.page.colId")}</th>
              <th style={{ width: 52 }}>{t("cameras.page.colLogo")}</th>
              <th>{t("cameras.page.colName")}</th>
              <th>{t("cameras.page.colZone")}</th>
              <th>{t("cameras.page.colLocation")}</th>
              <th>{t("cameras.page.colHost")}</th>
              <th style={{ width: 90 }}>{t("cameras.page.colStatus")}</th>
              <th style={{ width: 110 }}>{t("cameras.page.colEvents24h")}</th>
              <th>{t("cameras.page.colWorker")}</th>
              <th>{t("cameras.page.colDisplay")}</th>
              <th>{t("cameras.page.colDetection")}</th>
              <th>{t("cameras.page.colMatching")}</th>
              <th>{t("cameras.page.colClipSaving")}</th>
              <th style={{ textAlign: "right" }}>{t("cameras.page.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={15} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("cameras.page.loading")}
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={15}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  {t("cameras.page.loadError")}
                </td>
              </tr>
            )}
            {list.data?.items.map((cam) => {
              const metadataLine = [
                cam.detected_resolution_w && cam.detected_resolution_h
                  ? `${cam.detected_resolution_w}×${cam.detected_resolution_h}`
                  : null,
                cam.brand,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
              <tr key={cam.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(cam.id)}
                    onChange={() => toggleOne(cam.id)}
                    aria-label={t("cameras.page.selectCameraAria", { name: cam.name })}
                  />
                </td>
                <td className="mono text-sm" style={{ fontWeight: 600 }}>
                  {cam.camera_code}
                </td>
                <td style={{ textAlign: "center" }}>
                  <BrandLogo brand={cam.brand} size={32} />
                </td>
                <td>
                  <div style={{ fontWeight: 500 }}>{cam.name}</div>
                  {metadataLine && (
                    <div className="text-xs text-dim mono" style={{ marginTop: 2 }}>
                      {metadataLine}
                    </div>
                  )}
                </td>
                <td className="text-sm">
                  {cam.zone ? (
                    <span className="pill pill-neutral">{cam.zone}</span>
                  ) : (
                    <span className="text-xs text-dim">—</span>
                  )}
                </td>
                <td className="text-sm">{cam.location || "—"}</td>
                <td className="mono text-sm">{cam.rtsp_host}</td>
                <td>
                  <StatusDot camera={cam} worker={workerByCamera[cam.id]} />
                </td>
                <td className="mono text-sm">
                  {cam.images_captured_24h.toLocaleString()}
                </td>
                <td>
                  <Switch
                    checked={cam.worker_enabled}
                    onChange={() => toggleWorkerEnabled(cam)}
                    title={t("cameras.page.switchWorkerTitle")}
                  />
                </td>
                <td>
                  <Switch
                    checked={cam.display_enabled}
                    onChange={() => toggleDisplayEnabled(cam)}
                    title={t("cameras.page.switchDisplayTitle")}
                  />
                </td>
                <td>
                  <Switch
                    checked={cam.detection_enabled}
                    onChange={() => toggleDetectionEnabled(cam)}
                    title={t("cameras.page.switchDetectionTitle")}
                  />
                </td>
                <td>
                  <Switch
                    checked={cam.live_matching_enabled && cam.detection_enabled}
                    onChange={() => toggleMatchingEnabled(cam)}
                    disabled={!cam.detection_enabled}
                    title={
                      cam.detection_enabled
                        ? t("cameras.page.switchMatchingTitle")
                        : t("cameras.matchingNeedsDetection")
                    }
                  />
                </td>
                <td>
                  <Switch
                    checked={cam.clip_recording_enabled}
                    onChange={() => toggleClipRecordingEnabled(cam)}
                    title={t("cameras.page.switchClipTitle")}
                  />
                </td>
                <td style={{ textAlign: "right" }}>
                  <RowActionsMenu
                    onPreview={() => setPreviewTarget(cam)}
                    onEdit={() => openEdit(cam)}
                    onDelete={() => setDeleteTarget(cam)}
                  />
                </td>
              </tr>
              );
            })}
            {list.data && list.data.items.length === 0 && !list.isLoading && (
              <tr>
                <td colSpan={15} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("cameras.page.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showImport && <CameraImportModal onClose={() => setShowImport(false)} />}
      {drawerMode !== null && (
        <CameraDrawer
          mode={drawerMode}
          initial={editTarget}
          onClose={closeDrawer}
        />
      )}
      {previewTarget && (
        <PreviewModal
          camera={previewTarget}
          onClose={() => setPreviewTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmModal
          camera={deleteTarget}
          busy={del.isPending}
          onConfirm={() => {
            del.mutate(deleteTarget.id, {
              onSuccess: () => setDeleteTarget(null),
            });
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}

/**
 * Bulk Actions bar — appears above the table whenever ≥1 camera is
 * selected. Shows "N selected" plus an Enable / Disable pair for each of
 * the four operational settings (Worker / Display / Detection / Clip
 * Saving). Each button fires a single ``bulk-update`` with exactly one
 * boolean field set across every selected camera. Buttons disable while a
 * mutation is in flight. Layout reuses the design's ``card`` + ``btn`` +
 * ``btn-sm`` classes; the small inline styles match the inline-style
 * pattern already used elsewhere on this page.
 */
function BulkActionBar({
  count,
  busy,
  onApply,
  onClear,
}: {
  count: number;
  busy: boolean;
  onApply: (field: keyof typeof BULK_FIELDS, value: boolean) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const fields = Object.entries(BULK_FIELDS) as [
    keyof typeof BULK_FIELDS,
    (typeof BULK_FIELDS)[keyof typeof BULK_FIELDS],
  ][];
  return (
    <div
      className="card"
      role="region"
      aria-label={t("cameras.bulk.regionAria")}
      style={{
        marginBottom: 12,
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <strong style={{ fontSize: 13 }}>
          {t("cameras.bulk.selected", { count })}
        </strong>
        <button type="button" className="btn btn-sm" onClick={onClear}>
          {t("cameras.bulk.clear")}
        </button>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 14,
        }}
      >
        {fields.map(([field, labelKey]) => (
          <div
            key={field}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <span className="text-xs text-dim" style={{ fontWeight: 500 }}>
              {t(`cameras.bulk.${labelKey}`)}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => onApply(field, true)}
              title={t("cameras.bulk.enableTitle", {
                setting: t(`cameras.bulk.${labelKey}`),
                count,
              })}
            >
              {t("cameras.bulk.enable")}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => onApply(field, false)}
              title={t("cameras.bulk.disableTitle", {
                setting: t(`cameras.bulk.${labelKey}`),
                count,
              })}
            >
              {t("cameras.bulk.disable")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * iOS-style toggle switch — 36×20 pill with a sliding thumb. Used in
 * the Worker / Display / Detection columns of the Cameras table so
 * each row has a tactile on/off control instead of a static pill.
 * Background flips between accent (on) and the design's neutral
 * border tone (off); thumb translates to the right when checked.
 */
function Switch({
  checked,
  onChange,
  title,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={disabled ? undefined : onChange}
      title={title}
      style={{
        appearance: "none",
        width: 36,
        height: 20,
        borderRadius: 999,
        background: checked ? "var(--success)" : "var(--border)",
        border: "none",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        display: "inline-block",
        transition: "background 120ms ease",
        outline: "none",
        verticalAlign: "middle",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          insetInlineStart: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "white",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          transition: "inset-inline-start 140ms ease",
        }}
      />
    </button>
  );
}

/**
 * Health pill — driven by the live ``capture_manager`` state surfaced
 * via ``/api/operations/workers``. Green when the worker is actually
 * running and its RTSP stage is healthy; amber while starting or
 * reconnecting; red when stopped/failed/unreachable; grey when the
 * operator has disabled the worker. This matches the colour the
 * Worker Monitoring page shows for the same camera, so the two
 * surfaces never disagree.
 */
function StatusDot({
  camera,
  worker,
}: {
  camera: Camera;
  worker: WorkerStats | undefined;
}) {
  const { t } = useTranslation();

  if (!camera.worker_enabled) {
    return (
      <Pill
        color="var(--text-tertiary)"
        label={t("cameras.status.off")}
        title={t("cameras.status.offTitle")}
      />
    );
  }

  if (!worker) {
    return (
      <Pill
        color="var(--warning)"
        label={t("cameras.status.starting")}
        title={t("cameras.status.startingTitle")}
      />
    );
  }

  switch (worker.status) {
    case "running": {
      const rtsp = worker.stages.rtsp.state;
      if (rtsp === "green") {
        return (
          <Pill
            color="var(--success)"
            label={t("cameras.status.online")}
            title={
              worker.fps_reader
                ? t("cameras.status.readingFps", { fps: worker.fps_reader })
                : t("cameras.status.workerRunning")
            }
          />
        );
      }
      if (rtsp === "amber") {
        return (
          <Pill
            color="var(--warning)"
            label={t("cameras.status.degraded")}
            title={worker.stages.rtsp.detail || t("cameras.status.rtspIntermittent")}
          />
        );
      }
      return (
        <Pill
          color="var(--danger)"
          label={t("cameras.status.offline")}
          title={worker.stages.rtsp.detail || t("cameras.status.rtspNotReading")}
        />
      );
    }
    case "starting":
      return (
        <Pill
          color="var(--warning)"
          label={t("cameras.status.starting")}
          title={t("cameras.status.startingTitle")}
        />
      );
    case "reconnecting":
      return (
        <Pill
          color="var(--warning)"
          label={t("cameras.status.reconnecting")}
          title={worker.stages.rtsp.detail || t("cameras.status.tryingToReconnect")}
        />
      );
    case "failed":
      return (
        <Pill
          color="var(--danger)"
          label={t("cameras.status.failed")}
          title={worker.stages.rtsp.detail || t("cameras.status.workerFailed")}
        />
      );
    case "stopped":
    default:
      return (
        <Pill
          color="var(--danger)"
          label={t("cameras.status.offline")}
          title={worker.stages.rtsp.detail || t("cameras.status.workerStopped")}
        />
      );
  }
}

function Pill({
  color,
  label,
  title,
}: {
  color: string;
  label: string;
  title: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--text)",
        fontWeight: 500,
      }}
      title={title}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 0 2px ${color}33`,
        }}
      />
      {label}
    </span>
  );
}

/**
 * Per-row kebab menu — vertical 3-dots trigger that drops a small
 * popover with Preview / Edit / Delete. Mirrors the Employees page's
 * RowActionsMenu shape so the two surfaces feel consistent. Click-
 * outside + Esc close the popover (it's a small menu, not a modal —
 * the operator-policy red line that bars Esc/backdrop on
 * drawers/modals doesn't extend here).
 */
function RowActionsMenu({
  onPreview,
  onEdit,
  onDelete,
}: {
  onPreview: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className="icon-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((s) => !s);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("cameras.rowActions.aria")}
        title={t("cameras.rowActions.aria")}
      >
        <Icon name="moreVertical" size={14} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "100%",
            insetInlineEnd: 0,
            marginTop: 4,
            minWidth: 160,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 30,
            padding: 4,
          }}
        >
          <MenuItem icon="activity" label={t("cameras.rowActions.preview")} onClick={pick(onPreview)} />
          <MenuItem icon="settings" label={t("cameras.rowActions.edit")} onClick={pick(onEdit)} />
          <MenuItem
            icon="trash"
            label={t("cameras.rowActions.delete")}
            onClick={pick(onDelete)}
            danger
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: "activity" | "settings" | "trash";
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        textAlign: "start",
        background: "transparent",
        color: danger ? "var(--danger-text)" : "var(--text)",
        border: "none",
        cursor: "pointer",
        borderRadius: "var(--radius-sm)",
        fontSize: 12.5,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-sunken)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}

/**
 * Delete-confirmation modal — explicit Cancel / Delete buttons; no
 * Esc / backdrop dismiss (operator-policy red line). Spells out the
 * camera name so the operator can't mistakenly delete the wrong row.
 */
function DeleteConfirmModal({
  camera,
  busy,
  onConfirm,
  onClose,
}: {
  camera: Camera;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg)",
            width: 460,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "var(--danger-soft)",
                display: "grid",
                placeItems: "center",
                color: "var(--danger-text)",
              }}
            >
              <Icon name="trash" size={14} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {t("cameras.deleteModal.title")}
            </div>
          </div>
          <div
            className="text-sm text-dim"
            style={{ marginBottom: 16, lineHeight: 1.5 }}
          >
            {t("cameras.deleteModal.body", { name: camera.name })}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ background: "var(--danger)", color: "white" }}
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? t("cameras.deleteModal.deleting") : t("cameras.deleteModal.confirm")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
