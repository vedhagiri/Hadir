// Cameras list page — Admin only.
// Layout mirrors the design's page-header + card-wrapped table pattern.
// Per-row actions live in a vertical-3-dot kebab menu (Preview / Edit
// / Delete). Delete opens a confirmation modal before firing.
// The RTSP URL never appears in the UI — we show ``rtsp_host`` only.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { CardGrid, IconFact, EmptyPanel, FilterSelect, KebabMenu, ResetButton, SearchField, StatCard, StatGrid, Toolbar, ViewToggle, pct, useViewMode } from "../../components/ListPageUi";
import { Icon } from "../../shell/Icon";
import { BrandLogo } from "./BrandLogo";
import cameraDome from "../../assets/camera_dome.png";
import { CameraDrawer } from "./CameraDrawer";
import { CameraImportModal } from "./CameraImportModal";
import { PreviewModal } from "./PreviewModal";
import { AlertGlyph, InlineAlert, ModalFrame, StatusPill, Switch } from "./coreUi";
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

  const rowActions = (cam: Camera) => (
    <KebabMenu
      label={t("cameras.rowActions.aria")}
      items={[
        { label: t("cameras.rowActions.preview"), icon: <Icon name="activity" size={13} />, onClick: () => setPreviewTarget(cam) },
        { label: t("cameras.rowActions.edit"), icon: <Icon name="edit" size={13} />, onClick: () => openEdit(cam) },
        { label: t("cameras.rowActions.delete"), icon: <Icon name="trash" size={13} />, onClick: () => setDeleteTarget(cam), danger: true },
      ]}
    />
  );

  // Five page states (brief addendum): loading · API error · no cameras
  // at all · filters match nothing · normal list.
  const loadFailed = list.isError && !list.data;
  const noCameras = !!list.data && items.length === 0;
  const showChrome = !loadFailed && !noCameras;

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
      ) : showChrome ? (
      <StatGrid>
        <StatCard tone="info" icon={STAT_ICON.total} label={t("cameras.stats.total")} value={counts.total} sub={t("cameras.stats.totalSub")} active={statusF === ""} onClick={() => { setStatusF(""); setPage(1); }} />
        <StatCard tone="success" icon={STAT_ICON.online} label={t("cameras.stats.online")} value={counts.online} sub={t("cameras.stats.pctSub", { pct: pct(counts.online, counts.total) })} active={statusF === "online"} onClick={() => { setStatusF("online"); setPage(1); }} />
        <StatCard tone="warning" icon={STAT_ICON.reconnecting} label={t("cameras.stats.reconnecting")} value={counts.reconnecting} sub={t("cameras.stats.pctSub", { pct: pct(counts.reconnecting, counts.total) })} active={statusF === "reconnecting"} onClick={() => { setStatusF("reconnecting"); setPage(1); }} />
        <StatCard tone="danger" icon={STAT_ICON.offline} label={t("cameras.stats.offline")} value={counts.offline} sub={counts.disabled ? t("cameras.stats.offlineDisabledSub", { pct: pct(counts.offline, counts.total), n: counts.disabled }) : t("cameras.stats.pctSub", { pct: pct(counts.offline, counts.total) })} active={statusF === "offline"} onClick={() => { setStatusF("offline"); setPage(1); }} />
      </StatGrid>
      ) : null}

      {(list.isLoading || showChrome) && (
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
      )}

      {exportError && <InlineAlert tone="danger" onClose={() => setExportError(null)}>{exportError}</InlineAlert>}
      {bulkError && <InlineAlert tone="danger" onClose={() => setBulkError(null)}>{bulkError}</InlineAlert>}
      {bulkApplied !== null && selectedCount === 0 && (
        <InlineAlert tone="success" onClose={() => setBulkApplied(null)}>
          {t("cameras.bulk.applied", { count: bulkApplied })}
        </InlineAlert>
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
        {loadFailed ? (
          <EmptyPanel
            tone="danger"
            icon={<AlertGlyph />}
            title={t("cameras.empty.loadErrorTitle", { defaultValue: "Couldn't load cameras" })}
            body={extractApiError(list.error, t("cameras.page.loadError"))}
            actions={
              <button type="button" className="btn" onClick={() => void list.refetch()}>
                <Icon name="refresh" size={12} />
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        ) : list.data && filtered.length === 0 ? (
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
              <article key={cam.id} className={`co-card${selected.has(cam.id) ? " is-selected" : ""}`}>
                <div className="co-card-media">
                  <div className="co-card-media-tl">
                    <input
                      type="checkbox"
                      className="co-card-check"
                      checked={selected.has(cam.id)}
                      onChange={() => toggleOne(cam.id)}
                      aria-label={t("cameras.page.selectCameraAria", { name: cam.name })}
                    />
                    <span className="pill pill-neutral mono">{cam.camera_code}</span>
                  </div>
                  <div className="co-card-media-tr">{rowActions(cam)}</div>
                  <img src={cameraDome} alt="" />
                  <div className="co-card-media-bl">
                    <StatusDot camera={cam} worker={workerByCamera[cam.id]} />
                  </div>
                  <span className="co-card-media-br" title={cam.brand ?? undefined}>
                    <BrandLogo brand={cam.brand} size={22} />
                  </span>
                </div>
                <div className="co-card-body">
                  <div className="co-card-title-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="co-card-name" title={cam.name}>{cam.name}</div>
                      <div className="co-card-meta">
                        {[
                          cam.detected_resolution_w && cam.detected_resolution_h ? `${cam.detected_resolution_w}×${cam.detected_resolution_h}` : null,
                          cam.last_seen_at ? `${t("cameras.lastSeen.label")} · ${agoText(cam.last_seen_at, t)}` : null,
                        ].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                    {cam.zone && <ZonePill zone={cam.zone} />}
                  </div>
                  <div className="co-card-facts">
                    <IconFact icon={<FactIcon kind="location" />} label={t("cameras.page.colLocation")}>{cam.location || "—"}</IconFact>
                    <IconFact icon={<FactIcon kind="host" />} label={t("cameras.page.colHost")}><span className="mono">{cam.rtsp_host}</span></IconFact>
                    <IconFact icon={<FactIcon kind="events" />} label={t("cameras.page.colEvents24h")}><span className="mono">{cam.images_captured_24h.toLocaleString()}</span></IconFact>
                  </div>
                  <div className="co-card-switches">
                    {([
                      ["colWorker", cam.worker_enabled, () => toggleWorkerEnabled(cam), "switchWorkerTitle", "worker"],
                      ["colDetection", cam.detection_enabled, () => toggleDetectionEnabled(cam), "switchDetectionTitle", "detection"],
                      ["colDisplay", cam.display_enabled, () => toggleDisplayEnabled(cam), "switchDisplayTitle", "display"],
                      ["colRecording", cam.recording_mode === "save_clips", () => toggleRecordingMode(cam), "switchRecordingTitle", "recording"],
                    ] as const).map(([k, on, fn, title, icon]) => (
                      <div key={k} className="co-card-switch">
                        <span aria-hidden className="co-card-switch-icon"><FactIcon kind={icon} /></span>
                        <span className="co-card-switch-label">{t(`cameras.page.${k}`)}</span>
                        <Switch checked={on} onChange={fn} title={t(`cameras.page.${title}`)} label={`${t(`cameras.page.${k}`)} · ${cam.name}`} />
                      </div>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </CardGrid>
        ) : (
        <table className="table cameras-table">
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
              <th>{t("cameras.page.colRecording")}</th>
              <th style={{ textAlign: "end" }}>{t("cameras.page.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <SkeletonRows cols={14} />
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
                    <div className="text-xs text-dim" style={{ marginTop: 2, whiteSpace: "nowrap" }}>
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
                <td style={{ textAlign: "end" }}>
                  <div style={{ display: "inline-flex" }}>{rowActions(cam)}</div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        )}
        <div className="co-pager">
          <span className="text-sm text-dim">
            {t("cameras.page.showing", {
              from: filtered.length ? (safePage - 1) * PAGE_SIZE + 1 : 0,
              to: Math.min(safePage * PAGE_SIZE, filtered.length),
              total: filtered.length,
            })}
          </span>
          {/* Page buttons only once the list spills past one page. */}
          {pageCount > 1 && (
          <div className="co-pager-pages">
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
 * mutation is in flight.
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
      className="card co-bulkbar"
      role="region"
      aria-label={t("cameras.bulk.regionAria")}
    >
      <div className="co-bulkbar-group">
        <strong style={{ fontSize: 13 }}>
          {t("cameras.bulk.selected", { count })}
        </strong>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClear}>
          {t("cameras.bulk.clear")}
        </button>
      </div>
      <div className="co-bulkbar-group" style={{ gap: 14 }}>
        {fields.map(([field, labelKey]) => (
          <div key={field} className="co-bulkbar-field">
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

function StatusDot({ camera, worker }: { camera: Camera; worker: WorkerStats | undefined }) {
  const { t } = useTranslation();
  const h = cameraHealth(camera, worker);
  return (
    <StatusPill tone={h.key} title={h.detail || t(h.titleKey)}>
      {t(h.labelKey)}
    </StatusPill>
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
  return (
    <div className="text-xs text-dim" style={{ marginTop: 4, lineHeight: 1.35 }} title={new Date(at).toLocaleString()}>
      {t("cameras.lastSeen.label")}
      <br />
      {agoText(at, t)}
    </div>
  );
}

const ZONE_PILL: Record<string, string> = {
  Entry: "pill pill-info",
  Exit: "pill pill-warning",
};

function ZonePill({ zone }: { zone: string }) {
  return <span className={ZONE_PILL[zone] ?? "pill pill-neutral"}>{zone}</span>;
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
    <ModalFrame
      onClose={onClose}
      title={t("cameras.deleteModal.title")}
      icon={<Icon name="trash" size={16} />}
      body={t("cameras.deleteModal.body", { name: camera.name })}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            <Icon name="trash" size={12} />
            {busy ? t("cameras.deleteModal.deleting") : t("cameras.deleteModal.confirm")}
          </button>
        </>
      }
    />
  );
}
