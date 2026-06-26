// Pipeline Analytics — per-clip processing performance for UC1/UC2.
// A lightweight testing/optimization surface: UC1-vs-UC2 stage-time
// comparison, a per-clip metrics table, and a CSV export. Built to
// pinpoint where processing time goes (queue wait vs extract vs crop vs
// match) without external shell scripts.

import { useState } from "react";

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
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setDownloading(null);
    }
  }

  function setToday() {
    const t = todayIso();
    setFilters((f) => ({ ...f, start: t, end: t }));
    setPage(1);
  }

  // Each comparison row: label + accessor for the per-UC value.
  const COMPARE: { label: string; fmt: (r: PipelineSummaryRow) => string }[] = [
    { label: "Clips processed", fmt: (r) => String(r.count) },
    { label: "Avg total time", fmt: (r) => fmtMs(r.avg_total_ms) },
    { label: "P95 total time", fmt: (r) => fmtMs(r.p95_total_ms) },
    { label: "Max total time", fmt: (r) => fmtMs(r.max_total_ms) },
    { label: "Avg queue wait", fmt: (r) => fmtMs(r.avg_queue_ms) },
    { label: "Avg clip load (decrypt+read)", fmt: (r) => fmtMs(r.avg_load_ms) },
    { label: "Avg frame decode", fmt: (r) => fmtMs(r.avg_decode_ms) },
    { label: "Avg detection (extract)", fmt: (r) => fmtMs(r.avg_extract_ms) },
    { label: "  ↳ detect lock-wait", fmt: (r) => fmtMs(r.avg_lockwait_ms) },
    { label: "  ↳ detect compute", fmt: (r) => fmtMs(r.avg_detect_ms) },
    { label: "Avg face crop", fmt: (r) => fmtMs(r.avg_crop_ms) },
    { label: "Avg face match", fmt: (r) => fmtMs(r.avg_match_ms) },
    { label: "Avg frames sampled", fmt: (r) => num(r.avg_frames_sampled) },
    { label: "Avg frames motion-skipped", fmt: (r) => num(r.avg_frames_skipped) },
    { label: "Avg frames detected", fmt: (r) => num(r.avg_frames_detected) },
    { label: "Avg faces detected", fmt: (r) => num(r.avg_faces_detected) },
    { label: "Avg faces / crops saved", fmt: (r) => num(r.avg_face_crops) },
    { label: "Avg CPU", fmt: (r) => num(r.avg_cpu_percent, "%") },
    { label: "Avg memory", fmt: (r) => (r.avg_memory_mb == null ? "—" : `${r.avg_memory_mb} MB`) },
    { label: "Peak memory", fmt: (r) => (r.max_memory_mb == null ? "—" : `${r.max_memory_mb} MB`) },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Pipeline Analytics</h1>
          <p className="page-sub">
            End-to-end UC1 / UC2 processing metrics — find where time goes
            (queue wait · load · decode · detection · crop · match) and export
            for analysis. Exports honour the use-case · status · date filters.
            “ZIP + clips” bundles the decrypted videos (max 150, Admin-only,
            audited — contains PII).
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={() => setExportOpen(true)}
            disabled={downloading !== null}
          >
            <Icon name="download" size={13} />
            {downloading !== null ? "Downloading…" : "Download"}
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

      {/* Filters */}
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="flex gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <span className="text-dim" style={{ fontSize: 12.5 }}>Use case</span>
          {([
            { v: null, label: "Both" },
            { v: "uc1" as const, label: "UC1" },
            { v: "uc2" as const, label: "UC2" },
          ]).map((opt) => (
            <button
              key={opt.label}
              className="btn btn-sm"
              onClick={() => setUseCase(opt.v)}
              aria-pressed={filters.useCase === opt.v}
              style={
                filters.useCase === opt.v
                  ? { background: "var(--accent)", color: "white", borderColor: "var(--accent)" }
                  : undefined
              }
            >
              {opt.label}
            </button>
          ))}
          <span className="text-dim" style={{ fontSize: 12.5, marginInlineStart: 12 }}>Status</span>
          <select
            value={filters.status}
            onChange={(e) => {
              setFilters((f) => ({ ...f, status: e.target.value }));
              setPage(1);
            }}
            style={{
              padding: "6px 10px",
              fontSize: 12.5,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-elev)",
              color: "var(--text)",
            }}
          >
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="processing">Processing</option>
            <option value="pending">Pending</option>
            <option value="all">All</option>
          </select>

          <button
            className="btn btn-sm"
            onClick={setToday}
            aria-pressed={!!filters.start && filters.start === filters.end && filters.end === todayIso()}
            style={{ marginInlineStart: 12 }}
          >
            Today
          </button>
          <span className="text-dim" style={{ fontSize: 12.5, marginInlineStart: 4 }}>From</span>
          <DatePicker
            value={filters.start ?? ""}
            onChange={(next) => {
              setFilters((f) => ({ ...f, start: next || null }));
              setPage(1);
            }}
            max={todayIso()}
            ariaLabel="From date"
            placeholder="From"
          />
          <span className="text-dim" style={{ fontSize: 12.5 }}>To</span>
          <DatePicker
            value={filters.end ?? ""}
            onChange={(next) => {
              setFilters((f) => ({ ...f, end: next || null }));
              setPage(1);
            }}
            {...(filters.start ? { min: filters.start } : {})}
            max={todayIso()}
            ariaLabel="To date"
            placeholder="To"
          />
          {(filters.start || filters.end) && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setFilters((f) => ({ ...f, start: null, end: null }));
                setPage(1);
              }}
              aria-label="Clear date range"
            >
              <Icon name="x" size={11} /> Clear dates
            </button>
          )}
        </div>
      </div>

      {/* UC1 vs UC2 comparison */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <h3 className="card-title">UC1 vs UC2 comparison</h3>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Metric</th>
              <th style={{ width: 180 }}>UC1 (yolo+face)</th>
              <th style={{ width: 180 }}>UC2 (insightface)</th>
            </tr>
          </thead>
          <tbody>
            {summary.isLoading && (
              <tr><td colSpan={3} className="text-dim" style={{ padding: 14 }}>Loading…</td></tr>
            )}
            {!summary.isLoading && !uc1 && !uc2 && (
              <tr><td colSpan={3} className="text-dim" style={{ padding: 14 }}>No processed clips for this filter yet.</td></tr>
            )}
            {(uc1 || uc2) && COMPARE.map((c) => (
              <tr key={c.label}>
                <td className="text-sm">{c.label}</td>
                <td className="mono text-sm">{uc1 ? c.fmt(uc1) : "—"}</td>
                <td className="mono text-sm">{uc2 ? c.fmt(uc2) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-xs text-dim" style={{ padding: "8px 14px" }}>
          Queue wait, face crop, CPU and memory are captured for clips processed
          after this release; older clips show “—”.
        </div>
      </div>

      {/* Per-clip metrics */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Per-clip metrics</h3>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 70 }}>Clip</th>
              <th>Camera</th>
              <th style={{ width: 60 }}>UC</th>
              <th style={{ width: 90 }}>Total</th>
              <th style={{ width: 80 }}>Queue</th>
              <th style={{ width: 80 }}>Load</th>
              <th style={{ width: 80 }}>Decode</th>
              <th style={{ width: 80 }}>Lock</th>
              <th style={{ width: 80 }}>Detect</th>
              <th style={{ width: 70 }}>Crop</th>
              <th style={{ width: 70 }}>Match</th>
              <th style={{ width: 70, textAlign: "center" }}>Frames</th>
              <th style={{ width: 60, textAlign: "center" }}>Faces</th>
              <th style={{ width: 56, textAlign: "center" }}>Crops</th>
              <th style={{ width: 56 }}>CPU</th>
              <th style={{ width: 76 }}>Mem</th>
              <th style={{ width: 76 }}>Size</th>
            </tr>
          </thead>
          <tbody>
            {clips.isLoading && (
              <tr><td colSpan={17} className="text-dim" style={{ padding: 14 }}>Loading…</td></tr>
            )}
            {clips.isError && (
              <tr><td colSpan={17} style={{ padding: 14, color: "var(--danger-text)" }}>Failed to load.</td></tr>
            )}
            {!clips.isLoading && !clips.isError && total === 0 && (
              <tr><td colSpan={17} className="text-dim" style={{ padding: 14 }}>No clips match the current filter.</td></tr>
            )}
            {(clips.data?.items ?? []).map((c) => (
              <tr key={`${c.clip_id}-${c.use_case}`}>
                <td className="mono text-sm">#{c.clip_id}</td>
                <td className="text-sm">{c.camera_name ?? `cam ${c.camera_id ?? "?"}`}</td>
                <td className="text-sm">{c.use_case.toUpperCase()}</td>
                <td className="mono text-sm">{fmtMs(c.duration_ms)}</td>
                <td className="mono text-sm">{fmtMs(c.queue_wait_ms)}</td>
                <td className="mono text-sm">{fmtMs(c.clip_load_ms)}</td>
                <td className="mono text-sm">{fmtMs(c.frame_decode_ms)}</td>
                <td className="mono text-sm">{fmtMs(c.detect_lock_wait_ms)}</td>
                <td className="mono text-sm">{fmtMs(c.detect_compute_ms ?? c.face_extract_duration_ms)}</td>
                <td className="mono text-sm">{fmtMs(c.face_crop_ms)}</td>
                <td className="mono text-sm">{fmtMs(c.match_duration_ms)}</td>
                <td className="mono text-sm" style={{ textAlign: "center" }}>
                  {c.frames_detected == null ? "—" : `${c.frames_detected}/${c.frames_sampled ?? "?"}`}
                </td>
                <td className="mono text-sm" style={{ textAlign: "center" }}>{num(c.faces_detected)}</td>
                <td className="mono text-sm" style={{ textAlign: "center" }}>{c.face_crop_count}</td>
                <td className="mono text-sm">{num(c.cpu_percent, "%")}</td>
                <td className="mono text-sm">{c.memory_mb == null ? "—" : `${Math.round(c.memory_mb)} MB`}</td>
                <td className="mono text-sm">{fmtBytes(c.filesize_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {total > 0 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            disabled={clips.isFetching}
            summary={`Page ${page} of ${totalPages} · ${total.toLocaleString()} rows`}
          />
        )}
      </div>

      {exportOpen && (
        <ExportModal
          downloading={downloading}
          dateLabel={
            filters.start || filters.end
              ? `${filters.start ?? "…"} → ${filters.end ?? "…"}`
              : "all dates"
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
  const [uc, setUc] = useState<"both" | "uc1" | "uc2">("both");
  const [includeClips, setIncludeClips] = useState(false);
  const busy = downloading !== null;

  const UC_OPTS = [
    { v: "both" as const, label: "Both" },
    { v: "uc1" as const, label: "UC1" },
    { v: "uc2" as const, label: "UC2" },
  ];
  const FORMAT_OPTS = [
    {
      clips: false,
      icon: "fileText" as const,
      title: "CSV only",
      desc: "Performance metrics spreadsheet.",
    },
    {
      clips: true,
      icon: "videocam" as const,
      title: "ZIP + video clips",
      desc: "Metrics + decrypted MP4s (max 150). Contains PII.",
    },
  ];

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Download pipeline analytics"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 70,
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.30)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "18px 20px",
            borderBottom: "1px solid var(--border)",
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
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Download analytics
            </h2>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 1 }}>
              {dateLabel} · status &amp; camera filter applied
            </div>
          </div>
          <button
            className="btn btn-sm"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            style={{ padding: "4px 8px" }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Use case segmented */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-tertiary)" }}>
              Use case
            </span>
            <div
              style={{
                display: "flex",
                padding: 3,
                gap: 3,
                background: "var(--bg-sunken)",
                border: "1px solid var(--border)",
                borderRadius: 10,
              }}
            >
              {UC_OPTS.map((o) => {
                const on = uc === o.v;
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setUc(o.v)}
                    aria-pressed={on}
                    style={{
                      flex: 1,
                      padding: "7px 0",
                      fontSize: 13,
                      fontWeight: on ? 700 : 500,
                      borderRadius: 7,
                      border: "1px solid " + (on ? "var(--accent)" : "transparent"),
                      background: on ? "var(--accent)" : "transparent",
                      color: on ? "white" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Format cards */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-tertiary)" }}>
              Format
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
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "14px 20px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-sunken)",
          }}
        >
          <button className="btn btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onDownload(uc, includeClips)}
            disabled={busy}
          >
            <Icon name="download" size={12} />
            {busy
              ? includeClips ? "Bundling…" : "Exporting…"
              : includeClips ? "Download ZIP" : "Download CSV"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
