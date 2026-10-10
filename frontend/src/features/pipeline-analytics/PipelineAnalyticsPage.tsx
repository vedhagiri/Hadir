// Pipeline Analytics — per-clip processing performance for UC1/UC2.
// A lightweight testing/optimization surface: UC1-vs-UC2 stage-time
// comparison, a per-clip metrics table, and a CSV export. Built to
// pinpoint where processing time goes (queue wait vs extract vs crop vs
// match) without external shell scripts.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icon } from "../../shell/Icon";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { ModalShell } from "../../components/DrawerShell";
import { Pagination } from "../../components/Pagination";
import {
  downloadPipelineExport,
  usePipelineClips,
  usePipelineSummary,
} from "./hooks";
import type {
  PipelineFilters,
  PipelineSummaryRow,
  UseCase,
} from "./types";
import { SkeletonCards, SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel, FIELD_H, FilterSelect, ResetButton, StatGrid, Toolbar } from "../../components/ListPageUi";
import { StatTile, TILE_ICON } from "../person-clips/StatTile";

const PAGE_SIZE = 50;

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtBytes(b: number | null | undefined): string {
  if (!b) return "—";
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function num(n: number | null | undefined, suffix = ""): string {
  return n == null ? "—" : `${n}${suffix}`;
}

export function PipelineAnalyticsPage() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<PipelineFilters>({
    useCase: null,
    status: "completed",
    start: null,
    end: null,
  });
  const [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const summary = usePipelineSummary(filters);
  const clips = usePipelineClips(filters, page, PAGE_SIZE);

  const rows = summary.data?.use_cases ?? [];
  const uc1 = rows.find((r) => r.use_case === "uc1") ?? null;
  const uc2 = rows.find((r) => r.use_case === "uc2") ?? null;

  const total = clips.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setUseCase = (uc: UseCase | null) => {
    setFilters((f) => ({ ...f, useCase: uc }));
    setPage(1);
  };

  async function runExport(
    useCase: "both" | "uc1" | "uc2",
    includeClips: boolean,
  ): Promise<void> {
    setExportError(null);
    setDownloading(includeClips ? "zip" : "csv");
    try {
      await downloadPipelineExport(filters, {
        kind: includeClips ? "zip" : "csv",
        useCase: useCase === "both" ? null : useCase,
      });
      setExportOpen(false);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t("pipelineAnalytics.export.failed", { defaultValue: "Export failed" }));
    } finally {
      setDownloading(null);
    }
  }

  function setToday() {
    const today = todayIso();
    setFilters((f) => ({ ...f, start: today, end: today }));
    setPage(1);
  }

  // Each comparison row: label + accessor for the per-UC value.
  const cmp = (key: string, dv: string) => t(`pipelineAnalytics.compare.${key}`, { defaultValue: dv });
  const COMPARE: { key: string; label: string; sub?: boolean; fmt: (r: PipelineSummaryRow) => string }[] = [
    { key: "clips", label: cmp("clips", "Clips processed"), fmt: (r) => String(r.count) },
    { key: "avgTotal", label: cmp("avgTotal", "Avg total time"), fmt: (r) => fmtMs(r.avg_total_ms) },
    { key: "p95Total", label: cmp("p95Total", "P95 total time"), fmt: (r) => fmtMs(r.p95_total_ms) },
    { key: "maxTotal", label: cmp("maxTotal", "Max total time"), fmt: (r) => fmtMs(r.max_total_ms) },
    { key: "queue", label: cmp("queue", "Avg queue wait"), fmt: (r) => fmtMs(r.avg_queue_ms) },
    { key: "load", label: cmp("load", "Avg clip load (decrypt+read)"), fmt: (r) => fmtMs(r.avg_load_ms) },
    { key: "decode", label: cmp("decode", "Avg frame decode"), fmt: (r) => fmtMs(r.avg_decode_ms) },
    { key: "extract", label: cmp("extract", "Avg detection (extract)"), fmt: (r) => fmtMs(r.avg_extract_ms) },
    { key: "lockWait", label: cmp("lockWait", "detect lock-wait"), sub: true, fmt: (r) => fmtMs(r.avg_lockwait_ms) },
    { key: "detectCompute", label: cmp("detectCompute", "detect compute"), sub: true, fmt: (r) => fmtMs(r.avg_detect_ms) },
    { key: "crop", label: cmp("crop", "Avg face crop"), fmt: (r) => fmtMs(r.avg_crop_ms) },
    { key: "match", label: cmp("match", "Avg face match"), fmt: (r) => fmtMs(r.avg_match_ms) },
    { key: "framesSampled", label: cmp("framesSampled", "Avg frames sampled"), fmt: (r) => num(r.avg_frames_sampled) },
    { key: "framesSkipped", label: cmp("framesSkipped", "Avg frames motion-skipped"), fmt: (r) => num(r.avg_frames_skipped) },
    { key: "framesDetected", label: cmp("framesDetected", "Avg frames detected"), fmt: (r) => num(r.avg_frames_detected) },
    { key: "facesDetected", label: cmp("facesDetected", "Avg faces detected"), fmt: (r) => num(r.avg_faces_detected) },
    { key: "cropsSaved", label: cmp("cropsSaved", "Avg faces / crops saved"), fmt: (r) => num(r.avg_face_crops) },
    { key: "cpu", label: cmp("cpu", "Avg CPU"), fmt: (r) => num(r.avg_cpu_percent, "%") },
    { key: "memory", label: cmp("memory", "Avg memory"), fmt: (r) => (r.avg_memory_mb == null ? "—" : `${r.avg_memory_mb} MB`) },
    { key: "peakMemory", label: cmp("peakMemory", "Peak memory"), fmt: (r) => (r.max_memory_mb == null ? "—" : `${r.max_memory_mb} MB`) },
  ];

  const col = (key: string, dv: string) => t(`pipelineAnalytics.cols.${key}`, { defaultValue: dv });
  const statusValue = filters.status === "all" ? "" : filters.status;
  const filtersActive =
    filters.useCase !== null || filters.status !== "completed" || !!filters.start || !!filters.end;
  const isToday = !!filters.start && filters.start === filters.end && filters.end === todayIso();
  const resetFilters = () => {
    setFilters({ useCase: null, status: "completed", start: null, end: null });
    setPage(1);
  };
  const ucSub = (r: PipelineSummaryRow | null) =>
    r
      ? t("pipelineAnalytics.stats.ucSub", {
          defaultValue: "{{n}} clips · P95 {{p95}}",
          n: r.count.toLocaleString(),
          p95: fmtMs(r.p95_total_ms),
        })
      : t("pipelineAnalytics.stats.noData", { defaultValue: "no clips in this view" });

  // Addendum — list states. No processed clips at all (default filters):
  // hide the stat grid, toolbar and both cards; show one EmptyPanel.
  const noRecords = !clips.isLoading && !clips.isError && clips.data !== undefined && total === 0 && !filtersActive;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("pipelineAnalytics.title", { defaultValue: "Pipeline Analytics" })}</h1>
          <p className="page-sub">
            {t("pipelineAnalytics.sub", {
              defaultValue:
                "Where UC1 / UC2 clip-processing time goes — queue, load, decode, detection, crop and match. Downloads honour the filters below.",
            })}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={() => setExportOpen(true)}
            disabled={downloading !== null}
          >
            <Icon name="download" size={13} />
            {downloading !== null
              ? t("pipelineAnalytics.export.downloading", { defaultValue: "Downloading…" })
              : t("pipelineAnalytics.export.download", { defaultValue: "Download" })}
          </button>
        </div>
      </div>

      {exportError && (
        <div
          role="alert"
          className="card"
          style={{
            padding: "10px 14px",
            marginBottom: 14,
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
          }}
        >
          {exportError}
        </div>
      )}

      {clips.isError ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={28} />}
            title={t("pipelineAnalytics.errorTitle", { defaultValue: "Couldn’t load per-clip metrics" })}
            body={t("pipelineAnalytics.errorBody", { defaultValue: "Something went wrong while fetching this list. Try again in a moment." })}
            actions={
              <button type="button" className="btn" onClick={() => void clips.refetch()}>
                <Icon name="refresh" size={12} />
                {t("pipelineAnalytics.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : noRecords ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<Icon name="activity" size={28} />}
            title={t("pipelineAnalytics.emptyTitle", { defaultValue: "No processed clips yet" })}
            body={t("pipelineAnalytics.emptyBody", { defaultValue: "Metrics appear here once clips have been processed by UC1 or UC2." })}
            actions={
              <Link className="btn btn-primary" to="/clip-analytics">
                <Icon name="sparkles" size={12} />
                {t("pipelineAnalytics.goToClipAnalytics", { defaultValue: "Open Clip Analytics" })}
              </Link>
            }
          />
        </div>
      ) : (
      <>
      {summary.isLoading ? (
        <div style={{ marginBottom: 14 }}>
          <SkeletonCards count={3} minWidth={220} />
        </div>
      ) : (
        <StatGrid>
          <StatTile
            tone="info"
            icon={TILE_ICON.video}
            label={t("pipelineAnalytics.stats.clips", { defaultValue: "Clips in view" })}
            value={total.toLocaleString()}
            sub={t("pipelineAnalytics.stats.clipsSub", { defaultValue: "matching the current filters" })}
          />
          <StatTile
            tone="success"
            icon={TILE_ICON.pulse}
            label={t("pipelineAnalytics.stats.uc1", { defaultValue: "UC1 avg time" })}
            value={uc1 ? fmtMs(uc1.avg_total_ms) : "—"}
            sub={ucSub(uc1)}
          />
          <StatTile
            tone="warning"
            icon={TILE_ICON.pulse}
            label={t("pipelineAnalytics.stats.uc2", { defaultValue: "UC2 avg time" })}
            value={uc2 ? fmtMs(uc2.avg_total_ms) : "—"}
            sub={ucSub(uc2)}
          />
        </StatGrid>
      )}

      <Toolbar>
        <FilterSelect
          label={t("pipelineAnalytics.useCase", { defaultValue: "Use case" })}
          value={filters.useCase ?? ""}
          onChange={(v) => setUseCase(v === "" ? null : (v as UseCase))}
          options={[
            ["", t("pipelineAnalytics.both", { defaultValue: "Both" })],
            ["uc1", "UC1"],
            ["uc2", "UC2"],
          ]}
        />
        <FilterSelect
          label={t("pipelineAnalytics.status", { defaultValue: "Status" })}
          value={statusValue}
          onChange={(v) => {
            setFilters((f) => ({ ...f, status: v === "" ? "all" : v }));
            setPage(1);
          }}
          options={[
            ["", t("pipelineAnalytics.statusAll", { defaultValue: "All" })],
            ["completed", t("pipelineAnalytics.statusCompleted", { defaultValue: "Completed" })],
            ["failed", t("pipelineAnalytics.statusFailed", { defaultValue: "Failed" })],
            ["processing", t("pipelineAnalytics.statusProcessing", { defaultValue: "Processing" })],
            ["pending", t("pipelineAnalytics.statusPending", { defaultValue: "Pending" })],
          ]}
        />
        <button
          type="button"
          className="btn"
          onClick={setToday}
          aria-pressed={isToday}
          style={{
            height: FIELD_H,
            borderRadius: 10,
            ...(isToday ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : {}),
          }}
        >
          <Icon name="calendar" size={12} />
          {t("pipelineAnalytics.today", { defaultValue: "Today" })}
        </button>
        <DatePicker
          value={filters.start ?? ""}
          onChange={(next) => {
            setFilters((f) => ({ ...f, start: next || null }));
            setPage(1);
          }}
          max={todayIso()}
          ariaLabel={t("pipelineAnalytics.fromDate", { defaultValue: "From date" })}
          placeholder={t("pipelineAnalytics.from", { defaultValue: "From" })}
          triggerStyle={dateTriggerStyle}
        />
        <DatePicker
          value={filters.end ?? ""}
          onChange={(next) => {
            setFilters((f) => ({ ...f, end: next || null }));
            setPage(1);
          }}
          {...(filters.start ? { min: filters.start } : {})}
          max={todayIso()}
          ariaLabel={t("pipelineAnalytics.toDate", { defaultValue: "To date" })}
          placeholder={t("pipelineAnalytics.to", { defaultValue: "To" })}
          triggerStyle={dateTriggerStyle}
        />
        <ResetButton
          active={filtersActive}
          label={t("pipelineAnalytics.reset", { defaultValue: "Reset" })}
          onClick={resetFilters}
        />
      </Toolbar>

      {/* UC1 vs UC2 comparison */}
      <div className="card" style={{ padding: 12, marginBottom: 14 }}>
        <SectionHead
          title={t("pipelineAnalytics.compareTitle", { defaultValue: "UC1 vs UC2 comparison" })}
          sub={t("pipelineAnalytics.compareSub", { defaultValue: "Average and worst-case time per processing stage." })}
        />
        {!summary.isLoading && !uc1 && !uc2 ? (
          <EmptyPanel
            icon={<Icon name="activity" size={28} />}
            title={t("pipelineAnalytics.emptyCompareTitle", { defaultValue: "No processed clips for these filters" })}
            body={t("pipelineAnalytics.emptyCompareBody", { defaultValue: "Widen the date range or status filter to compare the two pipelines." })}
            {...(filtersActive
              ? {
                  actions: (
                    <button type="button" className="btn" onClick={resetFilters}>
                      <Icon name="refresh" size={12} />
                      {t("pipelineAnalytics.clearFilters", { defaultValue: "Clear filters" })}
                    </button>
                  ),
                }
              : {})}
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t("pipelineAnalytics.colMetric", { defaultValue: "Metric" })}</th>
                  <th style={{ width: 180 }}>{t("pipelineAnalytics.colUc1", { defaultValue: "UC1 (yolo+face)" })}</th>
                  <th style={{ width: 180 }}>{t("pipelineAnalytics.colUc2", { defaultValue: "UC2 (insightface)" })}</th>
                </tr>
              </thead>
              <tbody>
                {summary.isLoading && <SkeletonRows cols={3} />}
                {(uc1 || uc2) && COMPARE.map((c) => {
                  const sub = c.sub === true;
                  return (
                    <tr key={c.key}>
                      <td
                        className="text-sm"
                        style={sub ? { paddingInlineStart: 28, color: "var(--text-secondary)" } : { fontWeight: 500 }}
                      >
                        {sub ? `↳ ${c.label}` : c.label}
                      </td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{uc1 ? c.fmt(uc1) : "—"}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{uc2 ? c.fmt(uc2) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div
          className="text-xs text-dim"
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 4px 0" }}
        >
          <Icon name="info" size={12} />
          {t("pipelineAnalytics.compareNote", {
            defaultValue: "Queue wait, face crop, CPU and memory are captured for clips processed after this release; older clips show “—”.",
          })}
        </div>
      </div>

      {/* Per-clip metrics */}
      <div className="card" style={{ padding: 12 }}>
        <SectionHead
          title={t("pipelineAnalytics.perClipTitle", { defaultValue: "Per-clip metrics" })}
          sub={t("pipelineAnalytics.perClipSub", { defaultValue: "Stage timings for each processed clip, newest first." })}
        />
        {!clips.isLoading && total === 0 ? (
          <EmptyPanel
            icon={<Icon name={filtersActive ? "filter" : "videocam"} size={28} />}
            title={
              filtersActive
                ? t("pipelineAnalytics.emptyFilteredTitle", { defaultValue: "No clips match these filters" })
                : t("pipelineAnalytics.emptyTitle", { defaultValue: "No processed clips yet" })
            }
            body={
              filtersActive
                ? t("pipelineAnalytics.emptyFilteredBody", { defaultValue: "Try another use case, status or date range." })
                : t("pipelineAnalytics.emptyBody", { defaultValue: "Metrics appear here once clips have been processed by UC1 or UC2." })
            }
            {...(filtersActive
              ? {
                  actions: (
                    <button type="button" className="btn" onClick={resetFilters}>
                      <Icon name="refresh" size={12} />
                      {t("pipelineAnalytics.clearFilters", { defaultValue: "Clear filters" })}
                    </button>
                  ),
                }
              : {})}
          />
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>{col("clip", "Clip")}</th>
                    <th>{col("camera", "Camera")}</th>
                    <th style={{ width: 60 }}>{col("uc", "UC")}</th>
                    <th style={{ width: 90 }}>{col("total", "Total")}</th>
                    <th style={{ width: 80 }}>{col("queue", "Queue")}</th>
                    <th style={{ width: 80 }}>{col("load", "Load")}</th>
                    <th style={{ width: 80 }}>{col("decode", "Decode")}</th>
                    <th style={{ width: 80 }}>{col("lock", "Lock")}</th>
                    <th style={{ width: 80 }}>{col("detect", "Detect")}</th>
                    <th style={{ width: 70 }}>{col("crop", "Crop")}</th>
                    <th style={{ width: 70 }}>{col("match", "Match")}</th>
                    <th style={{ width: 70, textAlign: "center" }}>{col("frames", "Frames")}</th>
                    <th style={{ width: 60, textAlign: "center" }}>{col("faces", "Faces")}</th>
                    <th style={{ width: 56, textAlign: "center" }}>{col("crops", "Crops")}</th>
                    <th style={{ width: 56 }}>{col("cpu", "CPU")}</th>
                    <th style={{ width: 76 }}>{col("mem", "Mem")}</th>
                    <th style={{ width: 76 }}>{col("size", "Size")}</th>
                  </tr>
                </thead>
                <tbody>
                  {clips.isLoading && <SkeletonRows cols={17} />}
                  {(clips.data?.items ?? []).map((c) => (
                    <tr key={`${c.clip_id}-${c.use_case}`}>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>#{c.clip_id}</td>
                      <td className="text-sm" style={{ whiteSpace: "nowrap", fontWeight: 500 }}>{c.camera_name ?? `cam ${c.camera_id ?? "?"}`}</td>
                      <td className="text-sm"><UcPill uc={c.use_case} /></td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{fmtMs(c.duration_ms)}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{fmtMs(c.queue_wait_ms)}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{fmtMs(c.clip_load_ms)}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{fmtMs(c.frame_decode_ms)}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{fmtMs(c.detect_lock_wait_ms)}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{fmtMs(c.detect_compute_ms ?? c.face_extract_duration_ms)}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{fmtMs(c.face_crop_ms)}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{fmtMs(c.match_duration_ms)}</td>
                      <td className="mono text-sm" style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                        {c.frames_detected == null ? "—" : `${c.frames_detected}/${c.frames_sampled ?? "?"}`}
                      </td>
                      <td className="mono text-sm" style={{ textAlign: "center" }}>{num(c.faces_detected)}</td>
                      <td className="mono text-sm" style={{ textAlign: "center" }}>{c.face_crop_count}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{num(c.cpu_percent, "%")}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{c.memory_mb == null ? "—" : `${Math.round(c.memory_mb)} MB`}</td>
                      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{fmtBytes(c.filesize_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > 0 && (
              <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
                disabled={clips.isFetching}
                summary={t("pipelineAnalytics.pageSummary", {
                  defaultValue: "Page {{page}} of {{pages}} · {{rows}} rows",
                  page,
                  pages: totalPages,
                  rows: total.toLocaleString(),
                })}
              />
            )}
          </>
        )}
      </div>

      </>
      )}

      {exportOpen && (
        <ExportModal
          downloading={downloading}
          dateLabel={
            filters.start || filters.end
              ? `${filters.start ?? "…"} → ${filters.end ?? "…"}`
              : t("pipelineAnalytics.export.allDates", { defaultValue: "all dates" })
          }
          onClose={() => {
            if (downloading === null) setExportOpen(false);
          }}
          onDownload={runExport}
        />
      )}
    </>
  );
}

const dateTriggerStyle = {
  height: FIELD_H,
  minWidth: 160,
  padding: "0 12px",
  fontSize: 13,
  borderRadius: 10,
} as const;

function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ padding: "4px 4px 12px" }}>
      <h3 className="card-title" style={{ margin: 0 }}>{title}</h3>
      <div className="card-sub">{sub}</div>
    </div>
  );
}

function UcPill({ uc }: { uc: string }) {
  const one = uc === "uc1";
  return (
    <span className={`pill ${one ? "pill-success" : "pill-warning"}`}>
      <span className="pill-dot" aria-hidden />
      {uc.toUpperCase()}
    </span>
  );
}

function ExportModal({
  downloading,
  dateLabel,
  onClose,
  onDownload,
}: {
  downloading: string | null;
  dateLabel: string;
  onClose: () => void;
  onDownload: (uc: "both" | "uc1" | "uc2", includeClips: boolean) => void;
}) {
  const { t } = useTranslation();
  const [uc, setUc] = useState<"both" | "uc1" | "uc2">("both");
  const [includeClips, setIncludeClips] = useState(false);
  const busy = downloading !== null;

  const UC_OPTS = [
    { v: "both" as const, label: t("pipelineAnalytics.both", { defaultValue: "Both" }) },
    { v: "uc1" as const, label: "UC1" },
    { v: "uc2" as const, label: "UC2" },
  ];
  const FORMAT_OPTS = [
    {
      clips: false,
      icon: "fileText" as const,
      title: t("pipelineAnalytics.export.csvTitle", { defaultValue: "CSV only" }),
      desc: t("pipelineAnalytics.export.csvDesc", { defaultValue: "Performance metrics spreadsheet." }),
    },
    {
      clips: true,
      icon: "videocam" as const,
      title: t("pipelineAnalytics.export.zipTitle", { defaultValue: "ZIP + video clips" }),
      desc: t("pipelineAnalytics.export.zipDesc", { defaultValue: "Metrics + decrypted MP4s (max 150). Contains PII." }),
    },
  ];

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("pipelineAnalytics.export.aria", { defaultValue: "Download pipeline analytics" })}
        className="modal"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 70,
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          className="modal-head"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              flexShrink: 0,
              display: "grid",
              placeItems: "center",
              background: "var(--accent-soft, var(--bg-sunken))",
              color: "var(--accent)",
            }}
          >
            <Icon name="download" size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="modal-title" style={{ margin: 0 }}>
              {t("pipelineAnalytics.export.title", { defaultValue: "Download analytics" })}
            </h2>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 1 }}>
              {t("pipelineAnalytics.export.sub", { defaultValue: "{{range}} · status & camera filter applied", range: dateLabel })}
            </div>
          </div>
          <button
            className="btn btn-sm btn-ghost"
            onClick={onClose}
            disabled={busy}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Use case segmented */}
          <div className="field">
            <span className="field-label">
              {t("pipelineAnalytics.useCase", { defaultValue: "Use case" })}
            </span>
            <div className="seg" role="group" style={{ display: "flex" }}>
              {UC_OPTS.map((o) => {
                const on = uc === o.v;
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setUc(o.v)}
                    aria-pressed={on}
                    className={`seg-btn${on ? " active" : ""}`}
                    style={{ flex: 1 }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Format cards */}
          <div className="field">
            <span className="field-label">
              {t("pipelineAnalytics.export.format", { defaultValue: "Format" })}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {FORMAT_OPTS.map((o) => {
                const on = includeClips === o.clips;
                return (
                  <button
                    key={o.title}
                    type="button"
                    onClick={() => setIncludeClips(o.clips)}
                    aria-pressed={on}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      textAlign: "start",
                      padding: "12px 14px",
                      borderRadius: 11,
                      cursor: "pointer",
                      background: on ? "var(--accent-soft, var(--bg-sunken))" : "var(--bg)",
                      border: "1.5px solid " + (on ? "var(--accent)" : "var(--border)"),
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                        display: "grid", placeItems: "center", marginTop: 1,
                        background: on ? "var(--accent)" : "var(--bg-sunken)",
                        color: on ? "white" : "var(--text-secondary)",
                      }}
                    >
                      <Icon name={o.icon} size={15} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
                        {o.title}
                      </span>
                      <span style={{ display: "block", fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 2 }}>
                        {o.desc}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      style={{
                        width: 16, height: 16, borderRadius: "50%", flexShrink: 0, marginTop: 2,
                        border: "2px solid " + (on ? "var(--accent)" : "var(--border)"),
                        background: on ? "var(--accent)" : "transparent",
                        display: "grid", placeItems: "center",
                      }}
                    >
                      {on && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "white" }} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-foot" style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onDownload(uc, includeClips)}
            disabled={busy}
          >
            <Icon name="download" size={12} />
            {busy
              ? includeClips
                ? t("pipelineAnalytics.export.bundling", { defaultValue: "Bundling…" })
                : t("pipelineAnalytics.export.exporting", { defaultValue: "Exporting…" })
              : includeClips
                ? t("pipelineAnalytics.export.downloadZip", { defaultValue: "Download ZIP" })
                : t("pipelineAnalytics.export.downloadCsv", { defaultValue: "Download CSV" })}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
