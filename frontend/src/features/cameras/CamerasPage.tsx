// Cameras list page — Admin only.
// Layout mirrors the design's page-header + card-wrapped table pattern.
// Per-row actions live in a vertical-3-dot kebab menu (Preview / Edit
// / Delete). Delete opens a confirmation modal before firing.
// The RTSP URL never appears in the UI — we show ``rtsp_host`` only.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { CardGrid, IconFact, EmptyPanel, FilterSelect, ResetButton, SearchField, StatCard, StatGrid, Toolbar, ViewToggle, gridCardStyle, pct, useViewMode } from "../../components/ListPageUi";
import { Icon } from "../../shell/Icon";
import { BrandLogo } from "./BrandLogo";
import cameraDome from "../../assets/camera_dome.png";
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
import { SkeletonCards, SkeletonGrid, SkeletonRows } from "../../components/Skeleton";

// The four bulk-toggleable settings, in display order. The value is the
// i18n key suffix under ``cameras.bulk.*`` for the setting's label.
const BULK_FIELDS = {
  worker_enabled: "worker",
  display_enabled: "display",
  detection_enabled: "detection",
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

  // Filter bar + paging (client-side — a tenant has tens of cameras).
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState<HealthKey | "">("");
  const [zoneF, setZoneF] = useState("");
  const [typeF, setTypeF] = useState("");
  const [page, setPage] = useState(1);
  const [view, setView] = useViewMode("maugood.cameras.view");
  const health = (c: Camera) => cameraHealth(c, workerByCamera[c.id]);
  const counts = { total: items.length, online: 0, reconnecting: 0, offline: 0, disabled: 0 };
  items.forEach((c) => {
    counts[health(c).key] += 1;
  });
  const zones = Array.from(new Set(items.map((c) => c.zone).filter(Boolean) as string[])).sort();
  const brands = Array.from(new Set(items.map((c) => c.brand).filter(Boolean) as string[])).sort();
  const needle = q.trim().toLowerCase();
  const filtered = items.filter((c) => {
    if (statusF && health(c).key !== statusF) return false;
    if (zoneF && c.zone !== zoneF) return false;
    if (typeF && c.brand !== typeF) return false;
    if (needle) {
      const hay = [c.name, c.camera_code, c.location, c.rtsp_host, c.zone ?? "", c.brand ?? ""].join(" ").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const PAGE_SIZE = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const resetFilters = () => {
    setQ("");
    setStatusF("");
    setZoneF("");
    setTypeF("");
    setPage(1);
  };
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
  // Recording mode is a binary enum (save_clips ↔ logs_only) — the
  // switch maps ON = Save Clips (writes MP4), OFF = Logs Only
  // (presence row, no video). Lets the operator flip it inline
  // without opening the drawer.
  const toggleRecordingMode = (cam: Camera) => {
    patch.mutate({
      id: cam.id,
      patch: {
        recording_mode:
          cam.recording_mode === "save_clips" ? "logs_only" : "save_clips",
      },
    });
  };
  return (
    <>

      <div className="page-header">
        <div>
          <h1 className="page-title">{t("cameras.page.title")}</h1>
          <p className="page-sub">{t("cameras.page.subtitleV2")}</p>
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

      {list.isLoading ? (
        <div style={{ marginBottom: 14 }}>
          <SkeletonCards count={4} minWidth={220} />
        </div>
      ) : (
      <StatGrid>
        <StatCard tone="info" icon={STAT_ICON.total} label={t("cameras.stats.total")} value={counts.total} sub={t("cameras.stats.totalSub")} active={statusF === ""} onClick={() => { setStatusF(""); setPage(1); }} />
        <StatCard tone="success" icon={STAT_ICON.online} label={t("cameras.stats.online")} value={counts.online} sub={t("cameras.stats.pctSub", { pct: pct(counts.online, counts.total) })} active={statusF === "online"} onClick={() => { setStatusF("online"); setPage(1); }} />
        <StatCard tone="warning" icon={STAT_ICON.reconnecting} label={t("cameras.stats.reconnecting")} value={counts.reconnecting} sub={t("cameras.stats.pctSub", { pct: pct(counts.reconnecting, counts.total) })} active={statusF === "reconnecting"} onClick={() => { setStatusF("reconnecting"); setPage(1); }} />
        <StatCard tone="danger" icon={STAT_ICON.offline} label={t("cameras.stats.offline")} value={counts.offline} sub={counts.disabled ? t("cameras.stats.offlineDisabledSub", { pct: pct(counts.offline, counts.total), n: counts.disabled }) : t("cameras.stats.pctSub", { pct: pct(counts.offline, counts.total) })} active={statusF === "offline"} onClick={() => { setStatusF("offline"); setPage(1); }} />
      </StatGrid>
      )}

      <Toolbar>
        <SearchField
          value={q}
          onChange={(v) => { setQ(v); setPage(1); }}
          placeholder={t("cameras.filters.search")}
          clearLabel={t("cameras.filters.clearSearch")}
        />
        <FilterSelect
          label={t("cameras.filters.status")}
          value={statusF}
          onChange={(v) => { setStatusF(v as HealthKey | ""); setPage(1); }}
          options={[
            ["", t("cameras.filters.allStatus")],
            ["online", t("cameras.stats.online")],
            ["reconnecting", t("cameras.stats.reconnecting")],
            ["offline", t("cameras.stats.offline")],
            ["disabled", t("cameras.filters.disabled")],
          ]}
        />
        <FilterSelect
          label={t("cameras.filters.zone")}
          value={zoneF}
          onChange={(v) => { setZoneF(v); setPage(1); }}
          options={[["", t("cameras.filters.allZones")], ...zones.map((z) => [z, z] as [string, string])]}
        />
        <FilterSelect
          label={t("cameras.filters.type")}
          value={typeF}
          onChange={(v) => { setTypeF(v); setPage(1); }}
          options={[["", t("cameras.filters.allTypes")], ...brands.map((b) => [b, b] as [string, string])]}
        />
        <ResetButton active={!!(q || statusF || zoneF || typeF)} label={t("cameras.filters.reset")} onClick={resetFilters} />
        <ViewToggle value={view} onChange={setView} listLabel={t("cameras.view.list")} gridLabel={t("cameras.view.grid")} />
      </Toolbar>

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

      <div className="card" style={{ padding: 12 }}>
        {list.data && filtered.length === 0 ? (
          <CamerasEmptyState
            hasCameras={items.length > 0}
            q={q.trim()}
            statusF={statusF}
            zoneF={zoneF}
            typeF={typeF}
            onClear={resetFilters}
            onAdd={openAdd}
            onImport={() => setShowImport(true)}
          />
        ) : (
        <>
        {view === "grid" && list.isLoading ? (
          <SkeletonGrid count={3} minWidth={340} />
        ) : view === "grid" ? (
          <CardGrid minWidth={340}>
            {pageRows.map((cam) => (
              <div key={cam.id} style={{ ...gridCardStyle, padding: 16, gap: 14, borderColor: selected.has(cam.id) ? "var(--accent)" : "var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <input
                    type="checkbox"
                    checked={selected.has(cam.id)}
                    onChange={() => toggleOne(cam.id)}
                    aria-label={t("cameras.page.selectCameraAria", { name: cam.name })}
                  />
                  <span
                    aria-hidden
                    style={{ width: 66, height: 52, flex: "0 0 66px", borderRadius: 10, border: "1px solid var(--border)", background: "linear-gradient(160deg, var(--bg-elev), var(--bg-sunken))", display: "grid", placeItems: "center" }}
                  >
                    <img src={cameraDome} alt="" style={{ width: 46, height: 46, objectFit: "contain", display: "block" }} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cam.name}</div>
                    <div className="text-xs text-dim mono" style={{ marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {[cam.camera_code, cam.detected_resolution_w && cam.detected_resolution_h ? `${cam.detected_resolution_w}×${cam.detected_resolution_h}` : null].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <BrandLogo brand={cam.brand} size={28} />
                  <RowActionsMenu onPreview={() => setPreviewTarget(cam)} onEdit={() => openEdit(cam)} onDelete={() => setDeleteTarget(cam)} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <StatusDot camera={cam} worker={workerByCamera[cam.id]} />
                  {cam.last_seen_at && <LastSeenInline at={cam.last_seen_at} />}
                </div>
                <div style={{ display: "grid", gap: 2, padding: "10px 14px", borderRadius: 10, background: "var(--bg-sunken)" }}>
                  <IconFact icon={<FactIcon kind="zone" />} label={t("cameras.page.colZone")}>{cam.zone ? <ZonePill zone={cam.zone} /> : "—"}</IconFact>
                  <IconFact icon={<FactIcon kind="location" />} label={t("cameras.page.colLocation")}>{cam.location || "—"}</IconFact>
                  <IconFact icon={<FactIcon kind="host" />} label={t("cameras.page.colHost")}><span className="mono">{cam.rtsp_host}</span></IconFact>
                  <IconFact icon={<FactIcon kind="events" />} label={t("cameras.page.colEvents24h")}><span className="mono">{cam.images_captured_24h.toLocaleString()}</span></IconFact>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 18px" }}>
                  {([
                    ["colWorker", cam.worker_enabled, () => toggleWorkerEnabled(cam), "switchWorkerTitle", "worker"],
                    ["colDetection", cam.detection_enabled, () => toggleDetectionEnabled(cam), "switchDetectionTitle", "detection"],
                    ["colDisplay", cam.display_enabled, () => toggleDisplayEnabled(cam), "switchDisplayTitle", "display"],
                    ["colRecording", cam.recording_mode === "save_clips", () => toggleRecordingMode(cam), "switchRecordingTitle", "recording"],
                  ] as const).map(([k, on, fn, title, icon]) => (
                    <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
                      <span aria-hidden style={{ display: "inline-flex", color: "var(--text-tertiary)" }}><FactIcon kind={icon} /></span>
                      <span style={{ flex: 1 }}>{t(`cameras.page.${k}`)}</span>
                      <Switch checked={on} onChange={fn} title={t(`cameras.page.${title}`)} />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </CardGrid>
        ) : (
        <table className="table cameras-table">
          <thead>
            <tr style={{ background: "var(--bg-sunken)" }}>
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
              <th>{t("cameras.page.colRecording")}</th>
              <th style={{ textAlign: "right" }}>{t("cameras.page.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <SkeletonRows cols={14} />
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={14}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  {t("cameras.page.loadError")}
                </td>
              </tr>
            )}
            {pageRows.map((cam) => {
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
                <td className="mono text-sm" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                  {cam.camera_code}
                </td>
                <td style={{ textAlign: "center" }}>
                  <BrandLogo brand={cam.brand} size={32} />
                </td>
                <td>
                  <div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{cam.name}</div>
                  {metadataLine && (
                    <div className="text-xs text-dim mono" style={{ marginTop: 2, whiteSpace: "nowrap" }}>
                      {metadataLine}
                    </div>
                  )}
                </td>
                <td className="text-sm">
                  {cam.zone ? (
                    <ZonePill zone={cam.zone} />
                  ) : (
                    <span className="text-xs text-dim">—</span>
                  )}
                </td>
                <td className="text-sm">{cam.location || "—"}</td>
                <td className="mono text-sm">{cam.rtsp_host}</td>
                <td>
                  <StatusDot camera={cam} worker={workerByCamera[cam.id]} />
                  <LastSeen at={cam.last_seen_at} />
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
                    checked={cam.recording_mode === "save_clips"}
                    onChange={() => toggleRecordingMode(cam)}
                    title={`${t("cameras.page.switchRecordingTitle")} · ${
                      cam.recording_mode === "save_clips"
                        ? t("cameras.page.recordingClips")
                        : t("cameras.page.recordingLogs")
                    }`}
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
          </tbody>
        </table>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 6px 4px", gap: 12, flexWrap: "wrap" }}>
          <span className="text-sm text-dim">
            {t("cameras.page.showing", {
              from: filtered.length ? (safePage - 1) * PAGE_SIZE + 1 : 0,
              to: Math.min(safePage * PAGE_SIZE, filtered.length),
              total: filtered.length,
            })}
          </span>
          {/* Page buttons only once the list spills past one page. */}
          {pageCount > 1 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button type="button" className="btn btn-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label={t("common.previous")}>
              <Icon name="chevronLeft" size={12} />
            </button>
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className={n === safePage ? "btn btn-sm btn-primary" : "btn btn-sm"}
                aria-current={n === safePage ? "page" : undefined}
                onClick={() => setPage(n)}
                style={{ minWidth: 32, justifyContent: "center", borderRadius: 999 }}
              >
                {n}
              </button>
            ))}
            <button type="button" className="btn btn-sm" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)} aria-label={t("common.next")}>
              <Icon name="chevronRight" size={12} />
            </button>
          </div>
          )}
        </div>
        </>
        )}
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
 * the three operational settings (Worker / Display / Detection). Each
 * button fires a single ``bulk-update`` with exactly one
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

type HealthKey = "online" | "reconnecting" | "offline" | "disabled";

/**
 * Camera health, driven by the live ``capture_manager`` state from
 * ``/api/operations/workers`` (same source as Pipeline Monitor, so the
 * two surfaces never disagree). Online = running with a healthy RTSP
 * stage; Reconnecting = starting, reconnecting or RTSP intermittent;
 * Offline = stopped / failed / RTSP not reading; Disabled = worker
 * switched off by the operator.
 */
function cameraHealth(
  camera: Camera,
  worker: WorkerStats | undefined,
): { key: HealthKey; labelKey: string; titleKey: string; detail?: string } {
  if (!camera.worker_enabled) return { key: "disabled", labelKey: "cameras.status.off", titleKey: "cameras.status.offTitle" };
  if (!worker) return { key: "reconnecting", labelKey: "cameras.status.starting", titleKey: "cameras.status.startingTitle" };
  const detail = worker.stages.rtsp.detail || undefined;
  switch (worker.status) {
    case "running":
      if (worker.stages.rtsp.state === "green") return { key: "online", labelKey: "cameras.status.online", titleKey: "cameras.status.workerRunning" };
      if (worker.stages.rtsp.state === "amber") return { key: "reconnecting", labelKey: "cameras.status.degraded", titleKey: "cameras.status.rtspIntermittent", ...(detail ? { detail } : {}) };
      return { key: "offline", labelKey: "cameras.status.offline", titleKey: "cameras.status.rtspNotReading", ...(detail ? { detail } : {}) };
    case "starting":
      return { key: "reconnecting", labelKey: "cameras.status.starting", titleKey: "cameras.status.startingTitle" };
    case "reconnecting":
      return { key: "reconnecting", labelKey: "cameras.status.reconnecting", titleKey: "cameras.status.tryingToReconnect", ...(detail ? { detail } : {}) };
    case "failed":
      return { key: "offline", labelKey: "cameras.status.failed", titleKey: "cameras.status.workerFailed", ...(detail ? { detail } : {}) };
    default:
      return { key: "offline", labelKey: "cameras.status.offline", titleKey: "cameras.status.workerStopped", ...(detail ? { detail } : {}) };
  }
}

const HEALTH_TONE: Record<HealthKey, { dot: string; bg: string; fg: string }> = {
  online: { dot: "var(--success)", bg: "var(--success-soft)", fg: "var(--success-text)" },
  reconnecting: { dot: "var(--warning)", bg: "var(--warning-soft)", fg: "var(--warning-text)" },
  offline: { dot: "var(--danger)", bg: "var(--danger-soft)", fg: "var(--danger-text)" },
  disabled: { dot: "var(--text-tertiary)", bg: "var(--bg-sunken)", fg: "var(--text-secondary)" },
};

function StatusDot({ camera, worker }: { camera: Camera; worker: WorkerStats | undefined }) {
  const { t } = useTranslation();
  const h = cameraHealth(camera, worker);
  const tone = HEALTH_TONE[h.key];
  return (
    <span
      title={h.detail || t(h.titleKey)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "3px 10px",
        borderRadius: 8,
        background: tone.bg,
        color: tone.fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: tone.dot }} />
      {t(h.labelKey)}
    </span>
  );
}

/** Small stroke icons for the camera card's facts and switches. */
function FactIcon({ kind }: { kind: "zone" | "location" | "host" | "events" | "worker" | "detection" | "display" | "recording" }) {
  const paths: Record<typeof kind, React.ReactNode> = {
    zone: <><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></>,
    location: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4" /></>,
    host: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
    events: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
    worker: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    detection: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="3" /></>,
    display: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
    recording: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" fill="currentColor" /></>,
  };
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[kind]}
    </svg>
  );
}

function LastSeenInline({ at }: { at: string }) {
  const { t } = useTranslation();
  return (
    <span className="text-xs text-dim" title={new Date(at).toLocaleString()}>
      {t("cameras.lastSeen.label")} · {agoText(at, t)}
    </span>
  );
}

function agoText(at: string, t: ReturnType<typeof useTranslation>["t"]): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  return mins < 1
    ? t("cameras.lastSeen.now")
    : mins < 60
      ? t("cameras.lastSeen.mins", { count: mins })
      : mins < 1440
        ? t("cameras.lastSeen.hours", { count: Math.round(mins / 60) })
        : t("cameras.lastSeen.days", { count: Math.round(mins / 1440) });
}

function LastSeen({ at }: { at: string | null }) {
  const { t } = useTranslation();
  if (!at) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  const ago =
    mins < 1 ? t("cameras.lastSeen.now")
    : mins < 60 ? t("cameras.lastSeen.mins", { count: mins })
    : mins < 1440 ? t("cameras.lastSeen.hours", { count: Math.round(mins / 60) })
    : t("cameras.lastSeen.days", { count: Math.round(mins / 1440) });
  return (
    <div className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.35 }} title={new Date(at).toLocaleString()}>
      {t("cameras.lastSeen.label")}
      <br />
      {ago}
    </div>
  );
}

const ZONE_TONE: Record<string, { bg: string; fg: string }> = {
  Entry: { bg: "var(--info-soft)", fg: "var(--info-text)" },
  Exit: { bg: "var(--warning-soft)", fg: "var(--warning-text)" },
};

function ZonePill({ zone }: { zone: string }) {
  const tone = ZONE_TONE[zone] ?? { bg: "var(--bg-sunken)", fg: "var(--text-secondary)" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: tone.bg,
        color: tone.fg,
        border: `1px solid color-mix(in oklab, ${tone.fg} 25%, transparent)`,
      }}
    >
      {zone}
    </span>
  );
}













const STAT_ICON = {
  total: <><rect x="3" y="5" width="13" height="10" rx="2" /><path d="M16 9l5-2v8l-5-2M7 19h5M9.5 15v4" /></>,
  online: <><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19.5" r="1" fill="currentColor" /></>,
  reconnecting: <><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></>,
  offline: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>,
} as const;

/** Empty state for the camera list. The message follows whatever made
 *  the list empty: no cameras at all, a search with no hits, a single
 *  status card/filter with nothing in it, or a combination of filters. */
function CamerasEmptyState({
  hasCameras,
  q,
  statusF,
  zoneF,
  typeF,
  onClear,
  onAdd,
  onImport,
}: {
  hasCameras: boolean;
  q: string;
  statusF: HealthKey | "";
  zoneF: string;
  typeF: string;
  onClear: () => void;
  onAdd: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  const onlyStatus = !!statusF && !q && !zoneF && !typeF;

  let icon: React.ReactNode = <Icon name="camera" size={30} />;
  let title: string;
  let body: string;

  if (!hasCameras) {
    title = t("cameras.empty.noneTitle");
    body = t("cameras.empty.noneBody");
  } else if (onlyStatus) {
    // Nothing offline / reconnecting / disabled is good news → tick.
    icon = statusF === "online" ? <Icon name="activity" size={30} /> : <Icon name="check" size={30} />;
    title = t(`cameras.empty.status.${statusF}.title`);
    body = t(`cameras.empty.status.${statusF}.body`);
  } else if (q && !statusF && !zoneF && !typeF) {
    icon = <Icon name="search" size={28} />;
    title = t("cameras.empty.searchTitle", { q });
    body = t("cameras.empty.searchBody");
  } else {
    icon = <Icon name="filter" size={28} />;
    title = t("cameras.empty.filtersTitle");
    body = t("cameras.empty.filtersBody");
  }

  return (
    <EmptyPanel
      tone={!hasCameras ? "accent" : onlyStatus ? (statusF === "online" ? "warning" : "success") : "neutral"}
      icon={icon}
      title={title}
      body={body}
      actions={
        hasCameras ? (
          <button type="button" className="btn" onClick={onClear}>
            <Icon name="refresh" size={12} />
            {onlyStatus ? t("cameras.empty.showAll") : t("cameras.empty.clearFilters")}
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onImport}>
              <Icon name="upload" size={12} />
              {t("cameras.page.import")}
            </button>
            <button type="button" className="btn btn-primary" onClick={onAdd}>
              <Icon name="plus" size={12} />
              {t("cameras.page.addCamera")}
            </button>
          </>
        )
      }
    />
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
