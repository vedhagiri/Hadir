// Clip Analytics — every saved person clip, grouped by day.
//
// A clip is recorded when someone is in front of a camera; once it is
// saved it is sent automatically to face processing (UC1 / UC2) and the
// matched people feed attendance. This page answers "what was recorded,
// was it processed, and who was in it?":
//   * summary tiles for the selected range (clickable filters)
//   * toolbar: search · camera · status · result · video · date presets
//   * a pinned "Recording now" strip for clips still being written
//   * a day-grouped list with one combined Result pill per clip
//   * bulk Identify / Delete in a sticky bar that appears on selection
// Filters live in the URL so a view can be bookmarked or shared.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { api } from "../../api/client";
import { AnomalyInfoBanner } from "../../components/AnomalyNote";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import "../person-clips/clips.css";
import "./clip-analytics.css";
import { useTenantDateTime } from "../../util/datetime";
import { DatePicker } from "../../components/DatePicker";
import { Pagination } from "../../components/Pagination";
import { SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel, FilterSelect, ResetButton, SearchField, Toolbar } from "../../components/ListPageUi";
import type { IconName } from "../../shell/Icon";
import { useCameras } from "../cameras/hooks";
import { addDaysIso, tenantBound, tenantDayKey } from "../camera-logs/clUi";
import {
  useClipFaceCrops,
  useClipProcessingResults,
  useDeletePersonClip,
  useClipPipelineBatch,
  useClipPipelineStatus,
  useClipPipelineSubmit,
  useClipPipelineSubmitAll,
  useProcessedClipCounts,
  useReprocessStatus,
  useRetryFailed,
  useSingleClipReprocess,
} from "../person-clips/hooks";
import type { ClipPipelineBatch } from "../person-clips/hooks";
import { ClipDetailDrawer } from "../person-clips/PersonClipsPage";
import { DeleteClipsDialog } from "./DeleteClipsDialog";
import { DeletedClipName, displaySizeBytes, isVideoDeleted, useDeletedSizeTitle } from "../person-clips/deletedVideo";
import { useEnabledUseCases } from "../../hooks/useEnabledUseCases";
import type {
  ClipProcessingResult,
  FaceCropOut,
  PersonClipListResponse,
  PersonClipOut,
} from "../person-clips/types";
import { fmtBytes, fmtDuration, isClipInFlight } from "./caUi";
import { useClipList } from "./hooks";

const PAGE_SIZE = 50;
const BULK_DELETE_CAP = 200;

const ALL_USE_CASES = ["uc1", "uc2"] as const;
type UseCaseCode = (typeof ALL_USE_CASES)[number];

type RangePreset = "today" | "yesterday" | "7d" | "all" | "custom";
const RANGES: RangePreset[] = ["today", "yesterday", "7d", "all", "custom"];
const DEFAULT_RANGE: RangePreset = "7d";

const STATUSES = ["waiting", "processing", "queued", "saved", "processed", "failed", "stopped", "saving", "live"] as const;
type StatusFilter = (typeof STATUSES)[number];
const RESULTS = ["matched", "unknown", "no_faces", "unmatched"] as const;
const VIDEOS = ["on_disk", "deleted", "logs"] as const;

function pick<T extends string>(v: string | null, all: readonly T[]): T | null {
  return v && (all as readonly string[]).includes(v) ? (v as T) : null;
}

// Two-line "time over date" cell renderer for the Start / End columns.
// Replaces the dense locale string that mashed date + time together —
// HH:MM:SS is the scanning anchor (operators reason about clips in
// "minutes-ago" terms first), with a calendar context line below
// (``Today`` / ``Yesterday`` / ``Mon, May 15`` / ``May 15, 2025``).
//
// Locale-aware via Intl + the tenant's i18n language; the seconds row
// is monospaced so the column visually aligns down the table even when
// individual times differ.
function CellDateTime({
  iso,
  emphasize,
}: {
  iso: string | null | undefined;
  // ``emphasize`` lets the End-Time cell dim slightly so the eye
  // anchors on Start first and reads End as the secondary boundary —
  // tested as more scannable than two equally-weighted columns.
  emphasize?: boolean;
}) {
  const dt = useTenantDateTime();
  if (!iso) {
    return <span style={{ color: "var(--text-tertiary)" }}>—</span>;
  }
  let d: Date;
  try {
    d = new Date(iso);
  } catch {
    return <span className="mono text-sm">{iso}</span>;
  }
  if (!Number.isFinite(d.getTime())) {
    return <span className="mono text-sm">{iso}</span>;
  }

  // Migration 0068 — tenant tz + format. The Today/Yesterday
  // shortcuts still apply (relative anchors are more readable than
  // an absolute date for very recent events) but they compare
  // tenant-local calendar days, not browser-local.
  const tenantToday = dt.formatLocalDate(new Date().toISOString().slice(0, 10));
  const dDate = dt.formatDate(d);
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const tenantYesterday = dt.formatLocalDate(
    yesterdayDate.toISOString().slice(0, 10),
  );

  const timeStr = dt.formatTimeWithSeconds(d);
  const dateStr =
    dDate === tenantToday
      ? "Today"
      : dDate === tenantYesterday
        ? "Yesterday"
        : dDate;

  return (
    <div
      title={dt.formatDateTime(d)}
      style={{
        display: "flex",
        flexDirection: "column",
        lineHeight: 1.25,
        whiteSpace: "nowrap",
        opacity: emphasize === false ? 0.85 : 1,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text)",
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.01em",
        }}
      >
        {timeStr}
      </span>
      <span
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          fontWeight: dateStr === "Today" ? 600 : 400,
        }}
      >
        {dateStr}
      </span>
    </div>
  );
}



// Processing Status reflects the full per-clip lifecycle:
//   recording_status='recording'                       → "Recording"
//   recording_status='finalizing'                      → "Finalizing"
//   recording_status='completed' + processing UC(s)    → "Processing"
//   recording_status='completed' + no UC + no flight   → "Saved"
//   recording_status='completed' + ≥1 completed UC     → "Processed"
//
// Label is "Finalizing" (not "Encoding") because the clip-saving
// pipeline runs in ``stream_copy`` mode by default — the worker
// concat-copies pre-segmented H.264 chunks and Fernet-encrypts the
// result; no re-encode happens. The state name in the DB stays
// ``finalizing`` so the backend lifecycle + sweep paths are
// unchanged; this is a UI-only rename.
//
// "Processing" wins over "Processed" when at least one UC is still in
// flight (e.g. UC1 completed, UC2 still cropping) so the operator sees
// the live state, not the partial result.
// Returns the i18n key suffix under ``clipAnalytics.status.*`` for the
// clip's current state; the caller translates it (this helper is pure
// and has no ``t`` in scope).
/** Clip still being written — no video yet, not selectable. */

function processingStatusKey(c: PersonClipOut): string {
  // Migration 0075 — logs_only clips are presence logs: no video and no
  // UC pipeline. Surface "Logs only" instead of the misleading "Saved".
  if (c.recording_mode === "logs_only") return "logsOnly";
  switch (c.recording_status) {
    case "recording":
      return "recording";
    case "finalizing":
      return "finalizing";
    case "failed":
      return "failed";
    case "abandoned":
      // The recording ended before it was finalised (shutdown / crash
      // swept by the startup janitor) — not an error, so "Stopped early".
      return "stoppedEarly";
    case "completed":
    default:
      if ((c.processing_use_cases ?? []).length > 0) return "processing";
      // Queued: submitted to the pipeline, waiting for a worker — distinct
      // from "Processing" (actively running) and "Saved" (nothing queued).
      if ((c.pending_use_cases ?? []).length > 0) return "queued";
      return c.processed_use_cases.length > 0 ? "processed" : "saved";
  }
}

// Per-UC status pill for the Processed UCs column. Each clip carries
// ``processed_use_cases`` (completed) and ``processing_use_cases``
// (in-flight) — the cell renders one pill per known UC so an operator
// can see at a glance which of UC1 / UC2 has run, which is still
// running, and which hasn't started. A summary line under the pills
// surfaces the count + match outcome (matched vs unmatched) so the
// column conveys both pipeline progress and search result.

type UcCellState = "processed" | "processing" | "pending";

function ucState(code: string, c: PersonClipOut): UcCellState {
  if (c.processed_use_cases.includes(code)) return "processed";
  if ((c.processing_use_cases ?? []).includes(code)) return "processing";
  return "pending";
}

function UcPill({ code, state }: { code: string; state: UcCellState }) {
  const { t } = useTranslation();
  const palette: Record<UcCellState, {
    bg: string;
    fg: string;
    border: string;
    glyph: string;
    title: string;
  }> = {
    processed: {
      bg: "rgba(16,185,129,0.12)",
      fg: "#047857",
      border: "rgba(16,185,129,0.35)",
      glyph: "✓",
      title: t("clipAnalytics.uc.matchedProcessed"),
    },
    processing: {
      bg: "rgba(245,158,11,0.14)",
      fg: "#b45309",
      border: "rgba(245,158,11,0.4)",
      glyph: "⟳",
      title: t("clipAnalytics.uc.processingInProgress"),
    },
    pending: {
      bg: "var(--bg-sunken)",
      fg: "var(--text-tertiary)",
      border: "var(--border)",
      glyph: "—",
      title: t("clipAnalytics.uc.notProcessedYet"),
    },
  };
  const p = palette[state];
  return (
    <span
      title={t("clipAnalytics.uc.pillTitle", { uc: code.toUpperCase(), label: p.title })}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "1px 6px",
        borderRadius: 999,
        background: p.bg,
        color: p.fg,
        border: `1px solid ${p.border}`,
        fontSize: 10.5,
        fontWeight: 600,
        lineHeight: 1.4,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          minWidth: 9,
          textAlign: "center",
          fontSize: state === "processing" ? 11 : 9,
        }}
      >
        {p.glyph}
      </span>
      {code.toUpperCase()}
    </span>
  );
}

function ProcessedUcCell({ clip }: { clip: PersonClipOut }) {
  const { t } = useTranslation();
  const enabled = useEnabledUseCases();
  if (clip.recording_status !== "completed") {
    return (
      <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>—</span>
    );
  }

  // Only count / show the use cases enabled for this tenant (Detection &
  // Tracker → Clip processing). A tenant running only UC1 never sees UC2.
  const processedCount = clip.processed_use_cases.filter((u) =>
    (enabled as readonly string[]).includes(u),
  ).length;
  const total = enabled.length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <div
        style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
        aria-label={t("clipAnalytics.uc.statusAria")}
      >
        {enabled.map((uc) => (
          <UcPill key={uc} code={uc} state={ucState(uc, clip)} />
        ))}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {t("clipAnalytics.uc.processedCount", { count: processedCount, total })}
      </div>
    </div>
  );
}
function avatarBg(seed: string): string {
  const palette = [
    "#7c3aed",
    "#2563eb",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#06b6d4",
    "#8b5cf6",
    "#f97316",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] as string;
}


// ---------------------------------------------------------------------------
// Status pill — colour token map for the Processing Status column.
// ---------------------------------------------------------------------------

// Fallback labels for status keys that may not be in the locale bundle yet.
const STATUS_DEFAULT_LABEL: Record<string, string> = {
  stoppedEarly: "Stopped early",
  failed: "Failed",
};

function StatusPill({
  statusKey,
  onClick,
}: {
  // Stable key (recording/finalizing/failed/abandoned/processing/
  // processed/saved) — drives BOTH the colour switch and the i18n
  // lookup. Keying off the translated label would break colours in
  // non-English locales.
  statusKey: string;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const status = t(`clipAnalytics.status.${statusKey}`, {
    defaultValue: STATUS_DEFAULT_LABEL[statusKey] ?? statusKey,
  });
  const tone: { bg: string; fg: string } = (() => {
    switch (statusKey) {
      case "processed":
        // A clip that has at least one UC run — bright accent so it
        // stands out from the merely-Saved population.
        return {
          bg: "rgba(59,130,246,0.12)",
          fg: "#1d4ed8",
        };
      case "processing":
        // Live pipeline state — purple tone so it visually
        // distinguishes itself from both the terminal Processed
        // (blue) and the static Saved (green).
        return {
          bg: "rgba(139,92,246,0.14)",
          fg: "#6d28d9",
        };
      case "queued":
        // Waiting in the pipeline queue — amber, so it reads as
        // "not started yet" distinct from the active purple Processing.
        return {
          bg: "rgba(245,158,11,0.14)",
          fg: "#b45309",
        };
      case "saved":
        return { bg: "var(--success-soft)", fg: "var(--success-text)" };
      case "logsOnly":
        // Presence log — neutral slate tone, distinct from the green
        // "Saved" (which implies a stored video clip).
        return { bg: "rgba(100,116,139,0.14)", fg: "#475569" };
      case "recording":
        return { bg: "var(--danger-soft)", fg: "var(--danger-text)" };
      case "finalizing":
        return { bg: "var(--warning-soft)", fg: "var(--warning-text)" };
      case "failed":
        return { bg: "var(--danger-soft)", fg: "var(--danger-text)" };
      case "stoppedEarly":
        // Ended before finalising — not an error; amber, not red.
        return { bg: "var(--warning-soft)", fg: "var(--warning-text)" };
      default:
        return {
          bg: "var(--bg-elev, var(--bg))",
          fg: "var(--text-secondary)",
        };
    }
  })();
  // When ``onClick`` is supplied the pill renders as a button so the
  // operator can drill into the Live Processing modal — the keyboard
  // affordance + cursor cue make it obvious it's interactive.
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={t("clipAnalytics.statusPill.openLive")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: 999,
          fontSize: 11.5,
          fontWeight: 500,
          background: tone.bg,
          color: tone.fg,
          border: "1px solid transparent",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "currentColor";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "transparent";
        }}
      >
        {status}
        <Icon name="chevronRight" size={10} />
      </button>
    );
  }
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 500,
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {status}
    </span>
  );
}

export function ClipAnalyticsPage() {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const tz = dt.timezone;
  const enabledUcs = useEnabledUseCases();
  const [params, setParams] = useSearchParams();

  // ── URL state ────────────────────────────────────────────────────
  const qParam = params.get("q") ?? "";
  const camRaw = params.get("cam");
  const cameraId = camRaw && /^\d+$/.test(camRaw) ? Number(camRaw) : null;
  const status = pick(params.get("status"), STATUSES);
  const result = pick(params.get("result"), RESULTS);
  const video = pick(params.get("video"), VIDEOS);
  const ucFilter = pick(params.get("uc"), ["uc1", "uc2", "none"] as const);
  const range: RangePreset = pick(params.get("range"), RANGES) ?? DEFAULT_RANGE;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);

  const patch = (next: Record<string, string | null>, keepPage = false) => {
    setParams(
      (cur) => {
        const p = new URLSearchParams(cur);
        for (const [k, v] of Object.entries(next)) {
          if (v === null || v === "") p.delete(k);
          else p.set(k, v);
        }
        if (!keepPage) p.delete("page");
        return p;
      },
      { replace: true },
    );
  };

  // Search box → URL (debounced). Narrows the current page by clip
  // name, camera or #id.
  const [qInput, setQInput] = useState(qParam);
  useEffect(() => setQInput(qParam), [qParam]);
  useEffect(() => {
    if (qInput === qParam) return;
    const id = window.setTimeout(() => patch({ q: qInput.trim() || null }, true), 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  // ── Date range → tenant-local bounds ─────────────────────────────
  const todayKey = tenantDayKey(tz, new Date());
  const span = useMemo((): { from: string; to: string } | null => {
    switch (range) {
      case "today":
        return { from: todayKey, to: todayKey };
      case "yesterday": {
        const y = addDaysIso(todayKey, -1);
        return { from: y, to: y };
      }
      case "7d":
        return { from: addDaysIso(todayKey, -6), to: todayKey };
      case "custom": {
        const f = from || addDaysIso(todayKey, -6);
        const tt = to || todayKey;
        return { from: f, to: tt < f ? f : tt };
      }
      default:
        return null;
    }
  }, [range, from, to, todayKey]);

  // Range + camera only — shared by the list and the tiles.
  const baseQs = useMemo(() => {
    const p = new URLSearchParams();
    if (cameraId != null) p.set("camera_id", String(cameraId));
    if (span) {
      p.set("start", tenantBound(span.from, "00:00:00", tz));
      p.set("end", tenantBound(span.to, "23:59:59", tz));
    }
    return p.toString();
  }, [cameraId, span, tz]);

  const qs = useMemo(() => {
    const p = new URLSearchParams(baseQs);
    p.set("page", String(page));
    p.set("page_size", String(PAGE_SIZE));
    switch (status) {
      case "live":
        p.set("recording_status", "recording");
        break;
      case "saving":
        p.set("recording_status", "finalizing");
        break;
      case "failed":
        p.set("recording_status", "failed");
        break;
      case "stopped":
        p.set("recording_status", "abandoned");
        break;
      case "waiting":
      case "processing":
      case "queued":
      case "saved":
      case "processed":
        // Pipeline state is filtered SERVER-SIDE so total + pagination
        // stay correct.
        p.set("recording_status", "completed");
        p.set("processing_state", status);
        break;
      default:
        break;
    }
    if (result) p.set("match_result", result);
    if (video === "logs") p.set("recording_mode", "logs_only");
    else if (video) p.set("video", video);
    return p.toString();
  }, [baseQs, page, status, result, video]);

  const list = useClipList(qs);
  const camerasQuery = useCameras();
  const bulkDelete = useBulkDeletePersonClips();
  const retryFailed = useRetryFailed();
  const [retryNote, setRetryNote] = useState<string | null>(null);

  // ── Pipeline batch state (Identify Event) ────────────────────────
  const batchStatus = useReprocessStatus();
  const legacyBatchRunning = batchStatus.data?.status === "running" || batchStatus.data?.status === "starting";
  const pipelineStatus = useClipPipelineStatus();
  const activeBatches = useMemo(
    () => (pipelineStatus.data?.batches ?? []).filter((b) => b.completed_at === null),
    [pipelineStatus.data],
  );
  const batchRunning = legacyBatchRunning || activeBatches.length > 0;
  const [dismissedBatchIds, setDismissedBatchIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (activeBatches.length === 0 && dismissedBatchIds.size > 0) setDismissedBatchIds(new Set());
  }, [activeBatches.length, dismissedBatchIds.size]);
  const visibleActiveBatches = useMemo(
    () => activeBatches.filter((b) => !dismissedBatchIds.has(b.batch_id)),
    [activeBatches, dismissedBatchIds],
  );

  // ── Selection + modals ───────────────────────────────────────────
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [identifyTarget, setIdentifyTarget] = useState<PersonClipOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PersonClipOut | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<PersonClipOut | null>(null);
  const [liveTarget, setLiveTarget] = useState<PersonClipOut | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [identifySelectedOpen, setIdentifySelectedOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  // Page-local refinements: search + per-use-case filter.
  const items = useMemo(() => {
    let rows = list.data?.items ?? [];
    const q = qParam.trim().toLowerCase().replace(/^#/, "");
    if (q) {
      rows = rows.filter(
        (c) =>
          String(c.id).includes(q) ||
          (c.clip_name || "").toLowerCase().includes(q) ||
          (c.camera_name || "").toLowerCase().includes(q),
      );
    }
    if (ucFilter === "none") rows = rows.filter((c) => c.processed_use_cases.length === 0);
    else if (ucFilter) rows = rows.filter((c) => c.processed_use_cases.includes(ucFilter));
    return rows;
  }, [list.data, qParam, ucFilter]);

  const selectableItems = items.filter((c) => !isClipInFlight(c));
  const allOnPageSelected = selectableItems.length > 0 && selectableItems.every((c) => selected.has(c.id));
  // A selected clip that is (now) in flight is dropped from the selection.
  useEffect(() => {
    const inflight = items.filter((c) => isClipInFlight(c) && selected.has(c.id));
    if (inflight.length === 0) return;
    setSelected((cur) => {
      const next = new Set(cur);
      for (const c of inflight) next.delete(c.id);
      return next;
    });
  }, [items, selected]);

  const toggleSelectAllOnPage = () =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (allOnPageSelected) for (const c of selectableItems) next.delete(c.id);
      else for (const c of selectableItems) next.add(c.id);
      return next;
    });
  const toggleOne = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const deletedSizeTitle = useDeletedSizeTitle();
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersActive =
    !!qParam || cameraId !== null || status !== null || result !== null || video !== null || ucFilter !== null || range !== DEFAULT_RANGE;
  const resetAll = () => {
    setQInput("");
    setParams(new URLSearchParams(), { replace: true });
  };

  const rangeLabel = (r: RangePreset) =>
    ({
      today: t("clipAnalytics.v2.range.today", { defaultValue: "Today" }),
      yesterday: t("clipAnalytics.v2.range.yesterday", { defaultValue: "Yesterday" }),
      "7d": t("clipAnalytics.v2.range.last7", { defaultValue: "7 days" }),
      all: t("clipAnalytics.v2.range.all", { defaultValue: "All time" }),
      custom: t("clipAnalytics.v2.range.custom", { defaultValue: "Custom" }),
    })[r];

  const statusLabel: Record<StatusFilter, string> = {
    waiting: t("clipAnalytics.v2.status.waiting", { defaultValue: "Not processed yet" }),
    processing: t("clipAnalytics.v2.state.processing", { defaultValue: "Processing" }),
    queued: t("clipAnalytics.v2.state.queued", { defaultValue: "Queued" }),
    saved: t("clipAnalytics.v2.status.saved", { defaultValue: "Not started" }),
    processed: t("clipAnalytics.v2.state.processed", { defaultValue: "Processed" }),
    failed: t("clipAnalytics.v2.state.failed", { defaultValue: "Failed" }),
    stopped: t("clipAnalytics.v2.state.stopped", { defaultValue: "Stopped early" }),
    saving: t("clipAnalytics.v2.state.saving", { defaultValue: "Saving" }),
    live: t("clipAnalytics.v2.state.live", { defaultValue: "Recording" }),
  };


  const retryOne = (c: PersonClipOut) => {
    setRetryNote(null);
    retryFailed.mutate(
      { use_cases: ALL_USE_CASES.filter((uc) => !c.processed_use_cases.includes(uc)), max_clips: 1 },
      {
        onSuccess: (res) =>
          setRetryNote(
            res.clips_found === 0
              ? t("clipAnalytics.health.noFailedClips")
              : t("clipAnalytics.health.clipsFoundQueued", { found: res.clips_found, queued: res.queued_jobs }),
          ),
      },
    );
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("clipAnalytics.title")}</h1>
          <p className="page-sub">
            {t("clipAnalytics.v2.subtitle", {
              defaultValue:
                "Clips are recorded when someone is in front of a camera, then processed automatically to find and match faces.",
            })}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={() => setBatchOpen(true)}
            disabled={batchRunning}
            title={batchRunning ? t("clipAnalytics.batch.titleRunning") : t("clipAnalytics.v2.identifyHint", { defaultValue: "Run face processing again on saved clips" })}
          >
            <Icon name="sparkles" size={12} />
            {batchRunning ? t("clipAnalytics.batch.running") : t("clipAnalytics.identifyEvent")}
          </button>
          {selected.size > 0 && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setIdentifySelectedOpen(true)}
                disabled={batchRunning}
                title={t("clipAnalytics.identifySelected.titleN", { defaultValue: "Process {{count}} selected clip(s)", count: selected.size })}
              >
                <Icon name="sparkles" size={12} />
                {t("clipAnalytics.identifySelected.labelN", { defaultValue: "Identify selected ({{count}})", count: selected.size })}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setBulkDeleteOpen(true)}
                title={t("clipAnalytics.bulkDelete.tickedTitle", { count: selected.size })}
              >
                <Icon name="trash" size={12} />
                {t("clipAnalytics.bulkDelete.labelN", { count: selected.size })}
              </button>
            </>
          )}
        </div>
      </div>

      {visibleActiveBatches.length > 0 && (
        <PipelineBatchBanner
          batches={visibleActiveBatches}
          onOpen={() => setStatusOpen(true)}
          onDismiss={() => setDismissedBatchIds(new Set(activeBatches.map((b) => b.batch_id)))}
        />
      )}

      {retryNote && (
        <div className="ca-note" role="status">
          <Icon name="check" size={14} />
          <span>{retryNote}</span>
          <button type="button" className="ca-note-x" onClick={() => setRetryNote(null)} aria-label={t("common.close", { defaultValue: "Close" })}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      <Toolbar>
        <div className="ca-search-slot">
          <SearchField
            value={qInput}
            onChange={setQInput}
            placeholder={t("clipAnalytics.v2.search", { defaultValue: "Search clips or #id" })}
            clearLabel={t("clipAnalytics.toolbar.clearSearch", { defaultValue: "Clear search" })}
          />
        </div>
        <FilterSelect
          label={t("clipAnalytics.cols.camera")}
          value={cameraId === null ? "" : String(cameraId)}
          onChange={(v) => patch({ cam: v || null })}
          options={[
            ["", t("clipAnalytics.filters.allCameras")],
            ...(camerasQuery.data?.items ?? []).map((c) => [String(c.id), c.name] as [string, string]),
          ]}
        />
        <FilterSelect
          label={t("clipAnalytics.toolbar.status", { defaultValue: "Status" })}
          value={status ?? ""}
          onChange={(v) => patch({ status: v || null })}
          options={[["", t("clipAnalytics.status.all")], ...STATUSES.map((k) => [k, statusLabel[k]] as [string, string])]}
        />
        <FilterSelect
          label={t("clipAnalytics.v2.result.label", { defaultValue: "Result" })}
          value={result ?? ""}
          onChange={(v) => patch({ result: v || null })}
          options={[
            ["", t("clipAnalytics.v2.result.all", { defaultValue: "Any" })],
            ["matched", t("clipAnalytics.v2.result.matched", { defaultValue: "Matched" })],
            ["unknown", t("clipAnalytics.v2.result.unknownOpt", { defaultValue: "Unknown faces" })],
            ["no_faces", t("clipAnalytics.v2.result.noFaces", { defaultValue: "No faces" })],
            ["unmatched", t("clipAnalytics.v2.result.unmatchedOpt", { defaultValue: "No match (any)" })],
          ]}
        />
        <FilterSelect
          label={t("clipAnalytics.v2.video.label", { defaultValue: "Video" })}
          value={video ?? ""}
          onChange={(v) => patch({ video: v || null })}
          options={[
            ["", t("clipAnalytics.v2.result.all", { defaultValue: "Any" })],
            ["on_disk", t("clipAnalytics.v2.video.onDisk", { defaultValue: "On disk" })],
            ["deleted", t("clipAnalytics.v2.video.deleted", { defaultValue: "Deleted" })],
            ["logs", t("clipAnalytics.v2.video.logs", { defaultValue: "Presence logs (no video)" })],
          ]}
        />
        {enabledUcs.length > 1 && (
          <FilterSelect
            label={t("clipAnalytics.toolbar.processedUcs", { defaultValue: "Processed" })}
            value={ucFilter ?? ""}
            onChange={(v) => patch({ uc: v || null }, true)}
            options={[
              ["", t("clipAnalytics.ucFilter.any")],
              ...enabledUcs.map((uc) => [uc, uc.toUpperCase()] as [string, string]),
              ["none", t("clipAnalytics.ucFilter.notProcessed")],
            ]}
          />
        )}
        <div className="seg ca-seg" role="group" aria-label={t("clipAnalytics.v2.range.label", { defaultValue: "Date range" })}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              className={`seg-btn${range === r ? " active" : ""}`}
              onClick={() =>
                r === "custom"
                  ? patch({ range: "custom", from: span?.from ?? addDaysIso(todayKey, -6), to: span?.to ?? todayKey })
                  : patch({ range: r === DEFAULT_RANGE ? null : r, from: null, to: null })
              }
            >
              {rangeLabel(r)}
            </button>
          ))}
        </div>
        {range === "custom" && span && (
          <div className="ca-custom">
            <DatePicker
              value={span.from}
              max={span.to || todayKey}
              onChange={(v) => patch({ from: v })}
              ariaLabel={t("clipAnalytics.filters.byStartDate")}
              triggerStyle={{ height: "var(--control-h)" }}
            />
            <span className="ca-dim" aria-hidden>
              →
            </span>
            <DatePicker
              value={span.to}
              min={span.from}
              max={todayKey}
              onChange={(v) => patch({ to: v })}
              ariaLabel={t("clipAnalytics.filters.byEndDate")}
              triggerStyle={{ height: "var(--control-h)" }}
            />
          </div>
        )}
        <ResetButton active={filtersActive} label={t("clipAnalytics.filters.clear")} onClick={resetAll} />
      </Toolbar>

      <div className="card cl-table-scroll" style={{ padding: 12 }}>
        {/* Sticky thead is two rows: the column titles + a per-column
            filter row. Each <th>/<td> in the sticky region carries an
            opaque background so scrolling rows don't bleed through. */}
        <table
          className="table"
          style={
            {
              ["--mg-sticky-bg" as string]: "var(--bg-elev)",
            } as React.CSSProperties
          }
        >
          {/* Sticky thead — see EmployeesPage.tsx for the full rationale.
              ``--bg-elev`` (card surface) avoids a colour band against
              the card while rows scroll past; zIndex 20 sits above any
              stacking context a row introduces; the per-<th> ``inset``
              shadow paints the divider line *inside* the cell so a
              sub-pixel slit above the sticky can't leak content. */}
          <thead
            style={{
              position: "sticky",
              top: 0,
              zIndex: 20,
              background: "var(--bg-elev)",
            }}
          >
            {/* Row 1 — column titles */}
            <tr>
              <th
                style={{
                  width: 36,
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleSelectAllOnPage}
                  disabled={selectableItems.length === 0}
                  aria-label={t("clipAnalytics.selectAll")}
                />
              </th>
              <th
                style={{
                  width: 120,
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.id")}
              </th>
              <th
                style={{
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.camera")}
              </th>
              <th
                style={{
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.clipName")}
              </th>
              <th
                style={{
                  width: 160,
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.startTime")}
              </th>
              <th
                style={{
                  width: 160,
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.endTime")}
              </th>
              <th
                style={{
                  width: 90,
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.duration")}
              </th>
              <th
                style={{
                  width: 90,
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.fileSize")}
              </th>
              <th
                style={{
                  width: 140,
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.processingStatus")}
              </th>
              <th
                style={{
                  width: 150,
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.processedUcs")}
              </th>
              
              <th
                style={{
                  width: 60,
                  textAlign: "end",
                  background: "var(--bg-sunken)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <SkeletonRows cols={11} />
            )}
            {list.isError && (
              <tr>
                <td colSpan={11} style={{ padding: 0 }}>
                  <EmptyPanel
                    tone="danger"
                    icon={<Icon name="info" size={28} />}
                    title={t("clipAnalytics.loadError")}
                    body={t("clipAnalytics.toolbar.errorBody", { defaultValue: "Something went wrong while fetching clips. Try again in a moment." })}
                    actions={
                      <button type="button" className="btn" onClick={() => void list.refetch()}>
                        <Icon name="refresh" size={12} />
                        {t("clipAnalytics.toolbar.retry", { defaultValue: "Retry" })}
                      </button>
                    }
                  />
                </td>
              </tr>
            )}
            {!list.isLoading && !list.isError && items.length === 0 && (
              <tr>
                <td colSpan={11} style={{ padding: 0 }}>
                  {filtersActive ? (
                    <EmptyPanel
                      icon={<Icon name="filter" size={28} />}
                      title={t("clipAnalytics.toolbar.emptyFilteredTitle", { defaultValue: "No clips match these filters" })}
                      body={t("clipAnalytics.toolbar.emptyFilteredBody", { defaultValue: "Try a different search, camera, status or date range." })}
                      actions={
                        <button type="button" className="btn" onClick={resetAll}>
                          <Icon name="refresh" size={12} />
                          {t("clipAnalytics.toolbar.clearFilters", { defaultValue: "Clear filters" })}
                        </button>
                      }
                    />
                  ) : (
                    <EmptyPanel
                      tone="accent"
                      icon={<Icon name="videocam" size={28} />}
                      title={t("clipAnalytics.toolbar.emptyTitle", { defaultValue: "No clips yet" })}
                      body={t("clipAnalytics.empty")}
                    />
                  )}
                </td>
              </tr>
            )}
            {items.map((c) => {
              const isSelected = selected.has(c.id);
              // Migration 0054 / 0055 — recording + finalizing clips
              // have no playable MP4 yet. Row stays non-clickable so
              // we don't open an empty video modal on the partial
              // file. ``completed`` is the only state with a stable
              // artifact on disk. Migration 0075 — ``logs_only`` clips
              // are presence logs with no video at all, so they are
              // never clickable regardless of status.
              const playable =
                c.recording_status === "completed" &&
                c.recording_mode !== "logs_only";
              return (
                <tr
                  key={c.id}
                  onClick={
                    playable ? () => setDetailTarget(c) : undefined
                  }
                  title={
                    playable
                      ? t("clipAnalytics.row.clickDetails")
                      : t("clipAnalytics.row.detailsUnavailable", { status: c.recording_status })
                  }
                  style={{
                    cursor: playable ? "pointer" : "not-allowed",
                    background: isSelected
                      ? "var(--accent-soft)"
                      : undefined,
                  }}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected && !isClipInFlight(c)}
                      onChange={() => toggleOne(c.id)}
                      disabled={isClipInFlight(c)}
                      title={
                        isClipInFlight(c)
                          ? t("clipAnalytics.selectDisabledRecording", {
                              defaultValue: "Still recording — available when the clip finishes",
                            })
                          : undefined
                      }
                      aria-label={t("clipAnalytics.selectClip")}
                    />
                  </td>
                  <td className="mono text-sm" style={{ color: "var(--text-secondary)" }}>
                    #{c.id}
                  </td>
                  <td>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <div
                        className="avatar"
                        style={{
                          background: avatarBg(c.camera_name || "?"),
                          color: "var(--text-on-accent, #fff)",
                          display: "grid",
                          placeItems: "center",
                        }}
                        aria-hidden
                      >
                        <Icon name="camera" size={14} />
                      </div>
                      <div style={{ fontWeight: 500 }}>
                        {c.camera_name || "—"}
                      </div>
                    </div>
                  </td>
                  <td className="mono text-sm">
                    {isVideoDeleted(c) ? (
                      <DeletedClipName clip={c} name={c.clip_name || `clip-${c.id}`} />
                    ) : (
                      <span className="cell-ellipsis" title={c.clip_name || undefined}>{c.clip_name || "—"}</span>
                    )}
                  </td>
                  <td className="text-sm">
                    <CellDateTime iso={c.clip_start} />
                  </td>
                  <td className="text-sm">
                    <CellDateTime iso={c.clip_end} emphasize={false} />
                  </td>
                  <td className="mono text-sm">
                    {fmtDuration(c.duration_seconds)}
                  </td>
                  <td className="mono text-sm">
                    {isVideoDeleted(c) ? (
                      <span className="cl-deleted-size" title={deletedSizeTitle(c)}>
                        {fmtBytes(displaySizeBytes(c))}
                      </span>
                    ) : (
                      fmtBytes(c.filesize_bytes)
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <StatusPill
                      statusKey={processingStatusKey(c)}
                      onClick={() => setLiveTarget(c)}
                    />
                  </td>
                  <td className="text-sm">
                    <ProcessedUcCell clip={c} />
                  </td>
                  <td
                    onClick={(e) => e.stopPropagation()}
                    style={{ textAlign: "end" }}
                  >
                    <RowMenu
                      onViewDetails={
                        playable ? () => setDetailTarget(c) : undefined
                      }
                      onDelete={() => setDeleteTarget(c)}
                      onIdentify={
                        isVideoDeleted(c) || isClipInFlight(c) ? undefined : () => setIdentifyTarget(c)
                      }
                      onRetry={
                        !isVideoDeleted(c) &&
                        c.recording_status === "completed" &&
                        c.recording_mode !== "logs_only" &&
                        c.processed_use_cases.length < enabledUcs.length &&
                        (c.processing_use_cases ?? []).length === 0
                          ? () => retryOne(c)
                          : undefined
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Pagination — shared component. Hidden when empty so we don't
            advertise pages 1-N over a blank table. */}
        {total > 0 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={(p) => patch({ page: p > 1 ? String(p) : null }, true)}
            disabled={list.isFetching}
            summary={
              <>
                {t("clipAnalytics.pager.pageOf", {
                  page,
                  total: totalPages,
                  totalCount: total.toLocaleString(),
                })}
                {selected.size > 0 && (
                  <>
                    {" · "}
                    {t("clipAnalytics.pager.selected", { count: selected.size })}
                  </>
                )}
              </>
            }
          />
        )}
      </div>


      {identifyTarget && <IdentifyEventModal clip={identifyTarget} onClose={() => setIdentifyTarget(null)} />}
      {deleteTarget && <DeleteClipModal clip={deleteTarget} onClose={() => setDeleteTarget(null)} />}
      {bulkDeleteOpen && (
        <BulkDeleteClipsModal
          scope="selected"
          selectedIds={Array.from(selected)}
          selectedClips={items.filter((c) => selected.has(c.id))}
          filterQs={qs}
          onClose={() => setBulkDeleteOpen(false)}
          onDone={() => {
            setSelected(new Set());
            setBulkDeleteOpen(false);
            void list.refetch();
          }}
          mutation={bulkDelete}
        />
      )}
      {detailTarget && <ClipDetailDrawer clip={detailTarget} onClose={() => setDetailTarget(null)} />}
      {batchOpen && <BatchIdentifyEventModal onClose={() => setBatchOpen(false)} />}
      {identifySelectedOpen && (
        <IdentifySelectedModal
          clipIds={Array.from(selected)}
          onClose={() => setIdentifySelectedOpen(false)}
          onDone={() => setSelected(new Set())}
        />
      )}
      {statusOpen && (
        <BatchProcessStatusModal
          batches={activeBatches.concat((pipelineStatus.data?.batches ?? []).filter((b) => b.completed_at !== null))}
          onClose={() => setStatusOpen(false)}
        />
      )}
      {liveTarget && <LiveProcessingModal clip={liveTarget} onClose={() => setLiveTarget(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bulk-delete hook + modal.
//
// Backend: POST /api/person-clips/bulk-delete with {clip_ids: int[]}.
// Capped at 200 ids per request — the modal warns when the active
// filter matches more than that.
// ---------------------------------------------------------------------------

interface BulkDeleteClipResponse {
  deleted_count: number;
  deleted_ids: number[];
  skipped_ids?: number[];
}

function useBulkDeletePersonClips() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clip_ids: number[]) =>
      api<BulkDeleteClipResponse>("/api/person-clips/bulk-delete", {
        method: "POST",
        body: { clip_ids },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clip-analytics", "list"] });
    },
  });
}

function BulkDeleteClipsModal({
  scope,
  selectedIds,
  selectedClips,
  filterQs,
  onClose,
  onDone,
  mutation,
}: {
  scope: "selected" | "all";
  selectedIds: number[];
  /** Rows (from the current page) behind ``selectedIds`` — drive the
   *  dialog's summary. */
  selectedClips: PersonClipOut[];
  filterQs: string;
  onClose: () => void;
  onDone: () => void;
  mutation: ReturnType<typeof useBulkDeletePersonClips>;
}) {
  const { t } = useTranslation();
  const ids = selectedIds.slice(0, BULK_DELETE_CAP);
  const idSet = new Set(ids);
  const overCap = scope === "selected" && selectedIds.length > BULK_DELETE_CAP;

  const onDelete = async () => {
    let target = ids;
    if (scope === "all") {
      const p = new URLSearchParams(filterQs);
      p.set("page", "1");
      p.set("page_size", String(BULK_DELETE_CAP));
      const res = await api<PersonClipListResponse>(`/api/person-clips?${p.toString()}`);
      target = res.items.map((c) => c.id);
    }
    if (target.length === 0) throw new Error(t("clipAnalytics.bulkModal.errNone"));
    const res = await mutation.mutateAsync(target);
    // The server silently skips clips still recording / being saved
    // (and ids that no longer exist), so skipped = requested − deleted.
    return {
      deleted: res.deleted_count,
      skipped: res.skipped_ids?.length ?? Math.max(0, target.length - res.deleted_count),
    };
  };

  return (
    <DeleteClipsDialog
      count={scope === "all" ? BULK_DELETE_CAP : ids.length}
      clips={scope === "all" ? [] : selectedClips.filter((c) => idSet.has(c.id))}
      onCancel={onClose}
      onDelete={onDelete}
      onDone={onDone}
      extraNotice={
        scope === "all"
          ? t("clipAnalytics.bulkModal.capped", { cap: BULK_DELETE_CAP })
          : overCap
            ? t("clipAnalytics.bulkModal.overCap", { cap: BULK_DELETE_CAP, n: selectedIds.length })
            : null
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Row action menu — 3-dot kebab with Edit / Delete / Identify Event.
// ---------------------------------------------------------------------------

function RowMenu({
  onViewDetails,
  onDelete,
  onIdentify,
  onRetry,
}: {
  // ``onViewDetails`` is gated upstream — only ``completed`` clips
  // get the prop. ``recording`` / ``finalizing`` clips render the
  // menu without that entry.
  onViewDetails?: (() => void) | undefined;
  onDelete: () => void;
  // Omitted for clips whose video was deleted — re-identification
  // needs the video file.
  onIdentify?: (() => void) | undefined;
  // ``onRetry`` is only passed for clips with failed CPR rows so
  // the entry only appears when there is something to retry.
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className="icon-btn"
        aria-label={t("clipAnalytics.rowMenu.actions")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          padding: 4,
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        <Icon name="moreVertical" size={16} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            insetInlineEnd: 0,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-md, 0 4px 16px rgba(0,0,0,0.12))",
            minWidth: 180,
            padding: 4,
            zIndex: 10,
          }}
        >
          {onViewDetails && (
            <MenuItem
              label={t("clipAnalytics.rowMenu.viewDetails")}
              iconName="eye"
              onClick={() => {
                setOpen(false);
                onViewDetails();
              }}
            />
          )}
          {onIdentify && (
            <MenuItem
              label={t("clipAnalytics.identifyEvent")}
              iconName="user"
              onClick={() => {
                setOpen(false);
                onIdentify();
              }}
            />
          )}
          {onRetry && (
            <MenuItem
              label={t("clipAnalytics.rowMenu.retryFailed")}
              iconName="refresh"
              onClick={() => {
                setOpen(false);
                onRetry();
              }}
            />
          )}
          <MenuItem
            label={t("common.delete")}
            iconName="trash"
            danger
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  iconName,
  onClick,
  danger,
}: {
  label: string;
  iconName: IconName;
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
        padding: "6px 10px",
        fontSize: 13,
        textAlign: "start",
        background: "transparent",
        border: "none",
        borderRadius: "var(--radius-sm)",
        color: danger ? "var(--danger-text)" : "var(--text)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = danger
          ? "var(--danger-soft)"
          : "var(--bg, rgba(0,0,0,0.04))")
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon name={iconName} size={14} />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Identify Event modal — UC1 / UC2 selection + overwrite confirm.
// ---------------------------------------------------------------------------

type IdentifyStep = "pick" | "confirm-overwrite";

// ---- Identify Event — visual catalogue for the UC tiles ----

interface UseCaseTile {
  code: UseCaseCode;
  title: string;
  subtitle: string;
  speedLabel: string;
  speedTone: "fast" | "balanced" | "thorough";
  accuracyLabel: string;
  iconName: IconName;
  accent: string;
  accentSoft: string;
}

const UC_TILES: readonly UseCaseTile[] = [
  {
    code: "uc1",
    title: "Use Case 1 (High Accuracy)",
    subtitle: "Finds people first, then their faces — best for crowded or distant areas.",
    speedLabel: "Thorough",
    speedTone: "thorough",
    accuracyLabel: "Highest accuracy",
    iconName: "shield",
    accent: "#3b82f6",
    accentSoft: "rgba(59,130,246,0.12)",
  },
  {
    code: "uc2",
    title: "Use Case 2 (Standard)",
    subtitle: "Stores face crops with pose-aware quality scoring.",
    speedLabel: "Balanced",
    speedTone: "balanced",
    accuracyLabel: "Evidence trail",
    iconName: "user",
    accent: "#8b5cf6",
    accentSoft: "rgba(139,92,246,0.12)",
  },
];

// ---------------------------------------------------------------------------
// Batch Identify Event — runs the reprocess worker across every saved
// clip in this tenant. Reuses UC_TILES + UseCaseCard from the per-row
// modal; adds a mode radio (skip-existing vs reprocess-everything).
//
// Backend: POST /api/person-clips/reprocess-face-match
//   { mode: "skip_existing" | "all", use_cases: [...] }
// Progress is surfaced separately by the BatchProgressBanner via
// /api/person-clips/reprocess-status.
// ---------------------------------------------------------------------------

type BatchMode = "skip_existing" | "all";

// Compact "Identify selected" — process ONLY the checkbox-selected
// clips, instead of the all-tenant batch. Direct submit of the chosen
// clip_ids; default mode is overwrite since the operator deliberately
// picked these clips.
function IdentifySelectedModal({
  clipIds,
  onClose,
  onDone,
}: {
  clipIds: number[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const enabledUcs = useEnabledUseCases();
  const submit = useClipPipelineSubmit();
  const ucOptions = (["uc1", "uc2"] as const).filter((u) => enabledUcs.includes(u));
  const [ucs, setUcs] = useState<Set<string>>(() => new Set(["uc1"]));
  const [overwrite, setOverwrite] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggleUc = (u: string) =>
    setUcs((s) => {
      const next = new Set(s);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });

  async function run() {
    setError(null);
    if (ucs.size === 0) {
      setError(t("clipAnalytics.identifySelected.pickOne", { defaultValue: "Pick at least one use case." }));
      return;
    }
    try {
      const res = await submit.mutateAsync({
        clip_ids: clipIds,
        use_cases: Array.from(ucs),
        skip_existing: !overwrite,
      });
      setDone(
        t("clipAnalytics.identifySelected.submitted", {
          defaultValue: "Submitted {{jobs}} job(s) for {{clips}} clip(s)",
          jobs: res.queued_jobs,
          clips: clipIds.length,
        }) +
          (res.skipped_jobs
            ? ` · ${t("clipAnalytics.identifySelected.skipped", { defaultValue: "{{n}} skipped (already done).", n: res.skipped_jobs })}`
            : "."),
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("clipAnalytics.identifySelected.failed", { defaultValue: "Could not start processing." }));
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("clipAnalytics.identifySelected.modalTitle", { defaultValue: "Identify selected clips" })}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        zIndex: 80, display: "grid", placeItems: "center", padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !submit.isPending) onClose(); }}
    >
      <div
        style={{
          background: "var(--bg-elev)", border: "1px solid var(--border)",
          borderRadius: 14, width: 440, maxWidth: "calc(100vw - 32px)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.28)", overflow: "hidden",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden style={{ width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: "var(--accent-soft, var(--bg-sunken))", color: "var(--accent)" }}>
            <Icon name="sparkles" size={17} />
          </span>
          <div style={{ flex: 1 }}>
            <h2 className="modal-title" style={{ margin: 0, fontSize: 15.5 }}>{t("clipAnalytics.identifySelected.modalTitle", { defaultValue: "Identify selected clips" })}</h2>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 1 }}>
              {t("clipAnalytics.identifySelected.modalSub", { defaultValue: "Process only the {{count}} clip(s) you ticked — not the whole tenant.", count: clipIds.length })}
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={submit.isPending} aria-label={t("common.close")}><Icon name="x" size={12} /></button>
        </div>

        {done ? (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13.5, color: "var(--text)" }}>{done}</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary" onClick={onClose}>{t("common.done")}</button>
            </div>
          </div>
        ) : (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="field-label">{t("clipAnalytics.identifySelected.useCases", { defaultValue: "Use cases" })}</span>
              <div style={{ display: "flex", gap: 8 }}>
                {ucOptions.map((u) => {
                  const on = ucs.has(u);
                  return (
                    <button key={u} type="button" onClick={() => toggleUc(u)} aria-pressed={on}
                      style={{ flex: 1, padding: "8px 0", fontSize: 13, fontWeight: on ? 700 : 500, borderRadius: 8,
                        border: "1px solid " + (on ? "var(--accent)" : "var(--border)"),
                        background: on ? "var(--accent)" : "var(--bg)", color: on ? "white" : "var(--text-secondary)", cursor: "pointer" }}>
                      {u.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="field-label">{t("clipAnalytics.identifySelected.mode", { defaultValue: "Mode" })}</span>
              <label style={{ display: "flex", gap: 9, alignItems: "flex-start", cursor: "pointer" }}>
                <input type="radio" checked={overwrite} onChange={() => setOverwrite(true)} style={{ marginTop: 3 }} />
                <span style={{ fontSize: 13, color: "var(--text)" }}>{t("clipAnalytics.identifySelected.overwrite", { defaultValue: "Reprocess (overwrite)" })}
                  <span className="field-help" style={{ display: "block" }}>{t("clipAnalytics.identifySelected.overwriteHelp", { defaultValue: "Re-run these clips even if already processed." })}</span></span>
              </label>
              <label style={{ display: "flex", gap: 9, alignItems: "flex-start", cursor: "pointer" }}>
                <input type="radio" checked={!overwrite} onChange={() => setOverwrite(false)} style={{ marginTop: 3 }} />
                <span style={{ fontSize: 13, color: "var(--text)" }}>{t("clipAnalytics.identifySelected.skip", { defaultValue: "Skip already processed" })}
                  <span className="field-help" style={{ display: "block" }}>{t("clipAnalytics.identifySelected.skipHelp", { defaultValue: "Only run the selected clips that have no result yet." })}</span></span>
              </label>
            </div>

            {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--danger-text)" }}>{error}</div>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={onClose} disabled={submit.isPending}>{t("common.cancel")}</button>
              <button className="btn btn-primary" onClick={run} disabled={submit.isPending || ucs.size === 0}>
                <Icon name="sparkles" size={12} />
                {submit.isPending
                  ? t("clipAnalytics.identifySelected.submitting", { defaultValue: "Submitting…" })
                  : t("clipAnalytics.identifySelected.process", { defaultValue: "Process {{count}} clip(s)", count: clipIds.length })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BatchIdentifyEventModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const enabledUcs = useEnabledUseCases();
  // New pipeline path — submit-all resolves clips server-side, applies
  // overwrite cleanup (when not skip_existing), and returns a batch_id
  // we poll for live per-UC progress.
  const submitAll = useClipPipelineSubmitAll();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<Set<UseCaseCode>>(
    () => new Set(["uc1"] as UseCaseCode[]),
  );
  const [mode, setMode] = useState<BatchMode>("skip_existing");
  const [error, setError] = useState<string | null>(null);
  // Optional date/time filter — all four fields are independent. The
  // server applies them to ``person_clips.clip_start`` in the tenant's
  // local timezone. Empty string = no bound on that side. When
  // ``filterOpen`` is false the section collapses to a one-line
  // summary so operators with no filter need don't see the inputs.
  const [filterOpen, setFilterOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const hasFilter = !!(dateFrom || dateTo || timeFrom || timeTo);
  const overnight =
    !!timeFrom && !!timeTo && timeFrom > timeTo;
  // Holds the batch id returned by submit-all. When non-null, the modal
  // switches from the picker to the live-progress panel.
  const [batchId, setBatchId] = useState<string | null>(null);
  const batchStatus = useClipPipelineBatch(batchId);
  // When the operator picks ``all`` (overwrite) mode and clicks Start
  // we flip this to true and render a confirmation step inside the
  // same modal. Only an explicit second click on the confirm button
  // actually fires the reprocess. The flag clears on Cancel, on UC
  // change, or on Mode change.
  const [awaitingOverwriteConfirm, setAwaitingOverwriteConfirm] = useState(false);

  // Backend count of clips already done for the currently-selected
  // UCs. Fetched lazily — only when we actually enter the confirm
  // step, so the picker doesn't waste a request on every UC tick.
  const selectedList = Array.from(selected);
  const processedCounts = useProcessedClipCounts(
    selectedList,
    awaitingOverwriteConfirm && mode === "all",
  );

  const toggle = (uc: UseCaseCode) => {
    setAwaitingOverwriteConfirm(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uc)) next.delete(uc);
      else next.add(uc);
      return next;
    });
  };
  const pickMode = (m: BatchMode) => {
    setAwaitingOverwriteConfirm(false);
    setMode(m);
  };

  // Inflight = a batch is mid-process. The Start button stays disabled
  // while polling shows queued/in-flight jobs to prevent the operator
  // from accidentally launching a second batch on top of the first.
  const inflight =
    batchStatus.data !== null
    && batchStatus.data !== undefined
    && batchStatus.data.completed_at === null;

  const fireReprocess = async () => {
    setError(null);
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setError(t("clipAnalytics.batchModal.errDateInverted"));
      return;
    }
    try {
      const res = await submitAll.mutateAsync({
        use_cases: Array.from(selected),
        skip_existing: mode === "skip_existing",
        date_from: dateFrom || null,
        date_to: dateTo || null,
        time_from: timeFrom || null,
        time_to: timeTo || null,
      });
      // Flip into live-progress mode rather than closing — the
      // operator sees jobs flow queued → cropping → matching →
      // completed live. They can close the modal at any time; the
      // pipeline keeps running in the background.
      setBatchId(res.batch_id);
      qc.invalidateQueries({ queryKey: ["clip-analytics", "list"] });
      qc.invalidateQueries({ queryKey: ["clip-pipeline", "status"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("clipAnalytics.batchModal.errCouldNotStart"));
    }
  };

  const onStart = async () => {
    if (selected.size === 0) {
      setError(t("clipAnalytics.modal.errPickOne"));
      return;
    }
    // Overwrite mode requires an explicit second confirm — re-running
    // any UC that already has a clip_processing_results row destroys
    // the prior face crops + match details for that (clip, uc). The
    // confirm step renders inline so the operator stays in the same
    // popup flow.
    if (mode === "all" && !awaitingOverwriteConfirm) {
      setAwaitingOverwriteConfirm(true);
      setError(null);
      return;
    }
    await fireReprocess();
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background:
            "linear-gradient(180deg, rgba(10,12,20,0.55), rgba(10,12,20,0.72))",
          backdropFilter: "blur(2px)",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("clipAnalytics.batchModal.aria")}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "0 24px 64px rgba(10,12,20,0.35)",
            width: 720,
            maxWidth: "calc(100vw - 48px)",
            // Cap to the viewport and lay out as flex column so the
            // header + footer stay pinned while the middle body
            // scrolls. Without the maxHeight the modal grew past the
            // viewport on shorter screens with the date/time filter +
            // live progress panel both expanded; the title + close
            // button would fall off the top edge with no way to
            // reach them.
            maxHeight: "calc(100vh - 48px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Gradient header — distinct accent from the per-row modal
              (purple → indigo) so the operator visually registers
              they're firing a much larger action. */}
          <div
            style={{
              padding: "22px 22px 18px",
              background:
                "linear-gradient(135deg, #8b5cf6 0%, #6366f1 60%, #3b82f6 100%)",
              color: "white",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                aria-hidden
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.18)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Icon name="sparkles" size={20} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    opacity: 0.85,
                  }}
                >
                  {t("clipAnalytics.batchModal.eyebrow")}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
                  {t("clipAnalytics.batchModal.title")}
                </div>
              </div>
              {/* Header close button — always enabled. Closing does
                  NOT cancel a running batch; the pipeline keeps
                  draining on the backend and the operator can reopen
                  the progress view from "Batch Process Status". */}
              <button
                type="button"
                onClick={onClose}
                aria-label={t("common.close")}
                title={t("clipAnalytics.batchModal.closeTitle")}
                style={{
                  appearance: "none",
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.35)",
                  background: "rgba(255,255,255,0.15)",
                  color: "white",
                  display: "grid",
                  placeItems: "center",
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: "background 120ms ease-out",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.28)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.15)";
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div
              style={{
                marginTop: 12,
                fontSize: 12.5,
                lineHeight: 1.55,
                opacity: 0.92,
              }}
            >
              {batchId
                ? t("clipAnalytics.batchModal.introRunning")
                : t("clipAnalytics.batchModal.introIdle")}
            </div>
          </div>

          {/* Scrollable body — wraps the UC selection, date/time
              filter, mode picker, overwrite confirm, and live-progress
              panel so the header stays pinned at the top and the
              footer stays pinned at the bottom while the operator
              scrolls through everything in between. */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
            }}
          >
          {/* UC selection — reuses the per-row tile catalogue. */}
          <div style={{ padding: "18px 22px 6px" }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-secondary)",
                marginBottom: 10,
              }}
            >
              {t("clipAnalytics.batchModal.useCasesToRun")}
            </div>
            <div
              role="group"
              aria-label={t("clipAnalytics.pick.useCasesGroup")}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              {UC_TILES.filter((tile) =>
                (enabledUcs as readonly string[]).includes(tile.code),
              ).map((tile) => (
                <UseCaseCard
                  key={tile.code}
                  tile={tile}
                  checked={selected.has(tile.code)}
                  already={false}
                  onToggle={() => toggle(tile.code)}
                />
              ))}
            </div>
          </div>

          {/* Date / time filter — optional, collapsed by default.
              Empty fields mean "no bound on that side"; ``time_from
              > time_to`` is the overnight window the backend handles
              with an OR clause across midnight. */}
          <div style={{ padding: "16px 22px 4px" }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setFilterOpen((v) => !v)}
              aria-expanded={filterOpen}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-secondary)",
                padding: 0,
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              <Icon
                name={filterOpen ? "chevronDown" : "chevronRight"}
                size={12}
              />
              {t("clipAnalytics.batchModal.dateTimeFilter")}
              {hasFilter && (
                <span
                  className="mono"
                  style={{
                    background: "var(--accent-soft, rgba(99,102,241,0.10))",
                    color: "var(--accent-text, #4f46e5)",
                    border: "1px solid rgba(99,102,241,0.35)",
                    borderRadius: 999,
                    padding: "1px 8px",
                    fontSize: 10.5,
                  }}
                >
                  {t("clipAnalytics.batchModal.active")}
                </span>
              )}
            </button>
            {filterOpen && (
              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  background: "var(--bg-sunken)",
                }}
              >
                <FilterField
                  label={t("clipAnalytics.batchModal.dateFrom")}
                  inputType="date"
                  value={dateFrom}
                  onChange={setDateFrom}
                />
                <FilterField
                  label={t("clipAnalytics.batchModal.dateTo")}
                  inputType="date"
                  value={dateTo}
                  onChange={setDateTo}
                  min={dateFrom || undefined}
                />
                <FilterField
                  label={t("clipAnalytics.batchModal.timeFrom")}
                  inputType="time"
                  value={timeFrom}
                  onChange={setTimeFrom}
                />
                <FilterField
                  label={t("clipAnalytics.batchModal.timeTo")}
                  inputType="time"
                  value={timeTo}
                  onChange={setTimeTo}
                />
                <div
                  className="text-xs text-dim"
                  style={{
                    gridColumn: "1 / -1",
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  {t("clipAnalytics.batchModal.filterHelp")}
                  {overnight && (
                    <>
                      {" "}
                      {t("clipAnalytics.batchModal.overnight", { from: timeFrom, to: timeTo })}
                    </>
                  )}
                </div>
                {hasFilter && (
                  <div
                    style={{
                      gridColumn: "1 / -1",
                      display: "flex",
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setDateFrom("");
                        setDateTo("");
                        setTimeFrom("");
                        setTimeTo("");
                      }}
                    >
                      {t("clipAnalytics.batchModal.clearFilter")}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Mode picker — the load-bearing piece for "overall process". */}
          <div style={{ padding: "16px 22px 4px" }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-secondary)",
                marginBottom: 10,
              }}
            >
              {t("clipAnalytics.batchModal.mode")}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <ModeRow
                value="skip_existing"
                active={mode === "skip_existing"}
                onPick={() => pickMode("skip_existing")}
                title={t("clipAnalytics.batchModal.skipTitle")}
                subtitle={t("clipAnalytics.batchModal.skipSubtitle")}
              />
              <ModeRow
                value="all"
                active={mode === "all"}
                onPick={() => pickMode("all")}
                title={t("clipAnalytics.batchModal.allTitle")}
                subtitle={t("clipAnalytics.batchModal.allSubtitle")}
                tone="warn"
              />
            </div>
            {awaitingOverwriteConfirm && mode === "all" && (
              <div
                role="alertdialog"
                aria-label={t("clipAnalytics.batchModal.confirmOverwriteAria")}
                style={{
                  marginTop: 12,
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: "var(--danger-soft, rgba(239,68,68,0.10))",
                  border: "1px solid rgba(239,68,68,0.35)",
                  fontSize: 12.5,
                  lineHeight: 1.55,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 20, height: 20, borderRadius: "50%",
                      display: "grid", placeItems: "center",
                      background: "rgba(239,68,68,0.20)",
                      color: "var(--danger-text)",
                      fontWeight: 700,
                    }}
                  >
                    !
                  </span>
                  <strong style={{ color: "var(--danger-text)" }}>
                    {t("clipAnalytics.batchModal.overwriteRequired")}
                  </strong>
                </div>
                <p style={{ margin: "0 0 8px 0" }}>
                  {t("clipAnalytics.batchModal.blastRadius", {
                    ucs: Array.from(selected).map((u) => u.toUpperCase()).join(" / "),
                  })}
                </p>

                {/* Already-processed counts so the operator sees the
                    real blast radius before confirming. */}
                {processedCounts.isLoading && (
                  <div
                    style={{
                      margin: "0 0 8px 0",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      fontStyle: "italic",
                    }}
                  >
                    {t("clipAnalytics.batchModal.counting")}
                  </div>
                )}
                {processedCounts.data && (
                  <div
                    style={{
                      margin: "0 0 8px 0",
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: "rgba(255,255,255,0.55)",
                      border: "1px solid rgba(239,68,68,0.20)",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "var(--danger-text)",
                        marginBottom: 6,
                      }}
                    >
                      {t("clipAnalytics.batchModal.alreadyOverwritten")}
                    </div>
                    <ul
                      style={{
                        margin: 0,
                        paddingInlineStart: 18,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {Array.from(selected).map((uc) => {
                        const n = processedCounts.data!.per_uc[uc] ?? 0;
                        return (
                          <li key={uc} style={{ fontSize: 12.5 }}>
                            <strong>{uc.toUpperCase()}</strong>:{" "}
                            <span
                              style={{
                                color:
                                  n > 0
                                    ? "var(--danger-text)"
                                    : "var(--text-secondary)",
                                fontWeight: 600,
                              }}
                            >
                              {t("clipAnalytics.batchModal.ucClips", { count: n })}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 12,
                        color: "var(--text-secondary)",
                      }}
                    >
                      {t("clipAnalytics.batchModal.touchedSummary", {
                        touched: processedCounts.data.any_uc.toLocaleString(),
                        total: processedCounts.data.total_completed_clips.toLocaleString(),
                      })}
                    </div>
                  </div>
                )}

                <p style={{ margin: 0, color: "var(--text-secondary)" }}>
                  {t("clipAnalytics.batchModal.confirmHint")}
                </p>
              </div>
            )}
            {batchStatus.data && (
              <BatchLiveProgressPanel batch={batchStatus.data} />
            )}
            {error && (
              <div
                style={{
                  marginTop: 12,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  fontSize: 12.5,
                  border: "1px solid rgba(239,68,68,0.25)",
                }}
              >
                {error}
              </div>
            )}
          </div>
          </div>

          <ModalFooter
            leftSlot={
              <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {selected.size === 0
                  ? t("clipAnalytics.pick.noneSelected")
                  : `${t("clipAnalytics.batchModal.footerSummary", {
                      count: selected.size,
                      mode:
                        mode === "skip_existing"
                          ? t("clipAnalytics.banner.skipExisting")
                          : t("clipAnalytics.banner.overwrite"),
                    })}${hasFilter ? ` · ${t("clipAnalytics.batchModal.filtered")}` : ""}`}
              </div>
            }
          >
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (awaitingOverwriteConfirm) {
                  // Back out of the confirm step without leaving the
                  // modal so the operator can change UC selection or
                  // switch to skip_existing without losing context.
                  setAwaitingOverwriteConfirm(false);
                  return;
                }
                onClose();
              }}
              disabled={submitAll.isPending}
            >
              {awaitingOverwriteConfirm
                ? t("clipAnalytics.batchModal.back")
                : batchId
                  ? t("common.close")
                  : t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onStart()}
              disabled={
                submitAll.isPending || selected.size === 0 || inflight
              }
              style={
                mode === "all"
                  ? { background: "var(--danger)", color: "white" }
                  : undefined
              }
            >
              {submitAll.isPending
                ? t("clipAnalytics.batchModal.submitting")
                : inflight
                  ? t("clipAnalytics.batchModal.runningSeeProgress")
                  : mode === "all"
                    ? awaitingOverwriteConfirm
                      ? t("clipAnalytics.batchModal.confirmOverwrite")
                      : t("clipAnalytics.batchModal.reprocessEverything")
                    : t("clipAnalytics.batchModal.startProcessing")}
            </button>
          </ModalFooter>
        </div>
      </div>
    </ModalShell>
  );
}


// ── BatchLiveProgressPanel ────────────────────────────────────────────────
//
// Renders inside the Identify Event modal once the batch has been
// submitted to ``clip_pipeline``. Polls every 1.5 s via
// ``useClipPipelineBatch``. Shows:
//   * Scorecard — Selected / Completed / Skipped / Failed / Remaining
//   * Per-UC strip — for each requested UC: queued / cropping / matching
//     / completed / skipped / failed
//   * Progress bar — overall completion percentage
//
// Counts come straight from the ``BatchTracker`` on the backend, so
// what the operator sees matches the pipeline's real queue state.

function BatchLiveProgressPanel({
  batch,
}: {
  batch: import("../person-clips/hooks").ClipPipelineBatch;
}) {
  const { t } = useTranslation();
  const done = batch.completed_at !== null;
  const finished =
    batch.completed_jobs + batch.skipped_jobs + batch.failed_jobs;
  const pct =
    batch.total_jobs > 0
      ? Math.round((finished / batch.total_jobs) * 100)
      : 0;
  return (
    <div
      role="region"
      aria-label={t("clipAnalytics.batchProgress.aria")}
      style={{
        marginTop: 12,
        padding: "12px 14px",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "var(--bg-sunken)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            fontWeight: 700,
            color: "var(--text)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: done
                ? "var(--success-text)"
                : "var(--accent, #6366f1)",
              animation: done ? undefined : "pipeline-pulse 1.6s infinite",
            }}
          />
          {done ? t("clipAnalytics.batchProgress.complete") : t("clipAnalytics.batchProgress.running")}
          <span
            className="text-xs"
            style={{
              fontWeight: 500,
              color: "var(--text-secondary)",
              marginInlineStart: 4,
            }}
          >
            · #{batch.batch_id}
          </span>
        </div>
        <span
          className="mono"
          style={{ fontSize: 11, color: "var(--text-secondary)" }}
        >
          {pct}%
        </span>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--bg)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: done
              ? "var(--success-text)"
              : "var(--accent, #6366f1)",
            transition: "width 0.4s ease",
          }}
        />
      </div>

      {/* Scorecard — Selected / Completed / Skipped / Failed / Remaining */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 6,
        }}
      >
        <BatchStat label={t("clipAnalytics.stat.selected")} value={batch.total_jobs} />
        <BatchStat
          label={t("clipAnalytics.stat.completed")}
          value={batch.completed_jobs}
          color="var(--success-text)"
        />
        <BatchStat
          label={t("clipAnalytics.stat.skipped")}
          value={batch.skipped_jobs}
          color="var(--text-secondary)"
        />
        <BatchStat
          label={t("clipAnalytics.stat.failed")}
          value={batch.failed_jobs}
          color={
            batch.failed_jobs > 0 ? "var(--danger-text)" : undefined
          }
        />
        <BatchStat
          label={t("clipAnalytics.stat.remaining")}
          value={batch.remaining_jobs}
          color="var(--accent, #6366f1)"
        />
      </div>

      {/* In-flight detail */}
      {!done && (
        <div
          style={{
            display: "flex",
            gap: 12,
            fontSize: 11,
            color: "var(--text-secondary)",
            flexWrap: "wrap",
          }}
        >
          <span>
            <strong style={{ color: "var(--text)" }}>
              {batch.queued_jobs}
            </strong>{" "}
            {t("clipAnalytics.batchProgress.inQueue")}
          </span>
          <span>·</span>
          <span>
            <strong style={{ color: "var(--text)" }}>
              {batch.cropping_now}
            </strong>{" "}
            {t("clipAnalytics.batchProgress.cropping")}
          </span>
          <span>·</span>
          <span>
            <strong style={{ color: "var(--text)" }}>
              {batch.matching_now}
            </strong>{" "}
            {t("clipAnalytics.batchProgress.matching")}
          </span>
        </div>
      )}

      {/* Per-UC strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${batch.use_cases.length}, 1fr)`,
          gap: 8,
        }}
      >
        {batch.use_cases.map((uc) => {
          const s = batch.per_uc[uc];
          if (!s) return null;
          const ucFinished = s.completed + s.skipped + s.failed;
          const ucPct =
            s.total > 0 ? Math.round((ucFinished / s.total) * 100) : 0;
          return (
            <div
              key={uc}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "8px 10px",
                background: "var(--bg)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  marginBottom: 4,
                }}
              >
                <strong style={{ fontSize: 11, letterSpacing: "0.04em" }}>
                  {uc.toUpperCase()}
                </strong>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--text-secondary)" }}
                >
                  {ucFinished} / {s.total}
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  background: "var(--bg-sunken)",
                  borderRadius: 2,
                  overflow: "hidden",
                  marginBottom: 5,
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${ucPct}%`,
                    background: "var(--accent, #6366f1)",
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-secondary)",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                }}
              >
                <span>Q {s.queued}</span>
                <span>· C {s.cropping}</span>
                <span>· M {s.matching}</span>
                <span style={{ color: "var(--success-text)" }}>
                  · ✓ {s.completed}
                </span>
                {s.skipped > 0 && (
                  <span style={{ color: "var(--text-secondary)" }}>
                    · {t("clipAnalytics.batchProgress.skip")} {s.skipped}
                  </span>
                )}
                {s.failed > 0 && (
                  <span style={{ color: "var(--danger-text)" }}>
                    · {t("clipAnalytics.batchProgress.fail")} {s.failed}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {done && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--success-text)",
            fontWeight: 600,
          }}
        >
          {t("clipAnalytics.batchProgress.doneCompleted", { count: batch.completed_jobs })}
          {batch.skipped_jobs > 0
            ? ` · ${t("clipAnalytics.batchProgress.skippedN", { count: batch.skipped_jobs })}`
            : ""}
          {batch.failed_jobs > 0
            ? ` · ${t("clipAnalytics.batchProgress.failedN", { count: batch.failed_jobs })}`
            : ""}
        </div>
      )}
    </div>
  );
}


function BatchStat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string | undefined;
}) {
  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "6px 8px",
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          marginTop: 1,
          fontSize: 14,
          fontWeight: 700,
          color: color ?? "var(--text)",
        }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}


// Add keyframe for the pulsing in-progress dot if not already present.
if (typeof document !== "undefined") {
  const id = "clip-analytics-batch-pulse";
  if (!document.getElementById(id)) {
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `@keyframes pipeline-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0.5); }
      50% { box-shadow: 0 0 0 6px rgba(99,102,241,0); }
    }`;
    document.head.appendChild(s);
  }
}


// ── FilterField ───────────────────────────────────────────────────────────
// Labeled <input type="date"|"time"> used in the Date/Time filter
// section of the batch modal. Kept tiny on purpose — no validation
// hooks, no toggles. The server validates the strings on submit and
// returns a 400 with a precise message if anything is malformed.

function FilterField({
  label,
  inputType,
  value,
  onChange,
  min,
}: {
  label: string;
  inputType: "date" | "time";
  value: string;
  onChange: (next: string) => void;
  min?: string | undefined;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </span>
      <input
        type={inputType}
        value={value}
        min={min}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "6px 8px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          fontSize: 13,
          background: "var(--bg)",
          color: "var(--text)",
          fontFamily: "var(--font-sans)",
        }}
      />
    </label>
  );
}


// ── BatchProcessStatusModal ───────────────────────────────────────────────
// Page-level "live progress" surface for the queue pipeline. Renders
// one BatchLiveProgressPanel per batch, sorted active-first. Listens
// to ``useClipPipelineStatus`` so counters tick without the operator
// needing to keep the submit modal open. Closing the modal does NOT
// cancel anything — the pipeline keeps running in the background.

function BatchProcessStatusModal({
  batches,
  onClose,
}: {
  batches: ClipPipelineBatch[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const active = batches.filter((b) => b.completed_at === null);
  const done = batches.filter((b) => b.completed_at !== null);
  const totals = batches.reduce(
    (acc, b) => {
      acc.total += b.total_jobs;
      acc.completed += b.completed_jobs;
      acc.skipped += b.skipped_jobs;
      acc.failed += b.failed_jobs;
      acc.remaining += b.remaining_jobs;
      acc.cropping_now += b.cropping_now;
      acc.matching_now += b.matching_now;
      return acc;
    },
    {
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
      cropping_now: 0,
      matching_now: 0,
    },
  );

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background:
            "linear-gradient(180deg, rgba(10,12,20,0.55), rgba(10,12,20,0.72))",
          backdropFilter: "blur(2px)",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("clipAnalytics.batchStatus.label")}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "0 24px 64px rgba(10,12,20,0.35)",
            width: 760,
            maxWidth: "calc(100vw - 48px)",
            maxHeight: "calc(100vh - 48px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "18px 22px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              aria-hidden
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: "var(--accent-soft, rgba(99,102,241,0.10))",
                color: "var(--accent-text, #4f46e5)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Icon name="activity" size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--text-secondary)",
                }}
              >
                {t("clipAnalytics.batchStatus.eyebrow")}
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>
                {t("clipAnalytics.batchStatus.label")}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={onClose}
              aria-label={t("common.close")}
            >
              <Icon name="x" size={12} />
            </button>
          </div>

          <div
            style={{
              padding: "14px 22px",
              borderBottom: "1px solid var(--border)",
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 8,
            }}
          >
            <BatchStat label={t("clipAnalytics.stat.selected")} value={totals.total} />
            <BatchStat
              label={t("clipAnalytics.stat.completed")}
              value={totals.completed}
              color="var(--success-text)"
            />
            <BatchStat
              label={t("clipAnalytics.stat.skipped")}
              value={totals.skipped}
              color="var(--text-secondary)"
            />
            <BatchStat
              label={t("clipAnalytics.stat.failed")}
              value={totals.failed}
              color={
                totals.failed > 0 ? "var(--danger-text)" : undefined
              }
            />
            <BatchStat
              label={t("clipAnalytics.stat.remaining")}
              value={totals.remaining}
              color="var(--accent, #6366f1)"
            />
          </div>

          {active.length > 0 && (
            <div
              style={{
                padding: "8px 22px",
                fontSize: 12,
                color: "var(--text-secondary)",
                display: "flex",
                flexWrap: "wrap",
                gap: 14,
                background: "var(--bg-sunken)",
              }}
            >
              <span>
                <strong style={{ color: "var(--text)" }}>
                  {active.length}
                </strong>{" "}
                {t("clipAnalytics.batchStatus.activeBatches", { count: active.length })}
              </span>
              <span>·</span>
              <span>
                <strong style={{ color: "var(--text)" }}>
                  {totals.cropping_now}
                </strong>{" "}
                {t("clipAnalytics.batchStatus.croppingNow")}
              </span>
              <span>·</span>
              <span>
                <strong style={{ color: "var(--text)" }}>
                  {totals.matching_now}
                </strong>{" "}
                {t("clipAnalytics.batchStatus.matchingNow")}
              </span>
            </div>
          )}

          <div
            style={{
              padding: 22,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            {batches.length === 0 ? (
              <div
                className="text-sm text-dim"
                style={{ textAlign: "center", padding: 24 }}
              >
                {t("clipAnalytics.batchStatus.noBatches")}
              </div>
            ) : (
              <>
                {active.map((b) => (
                  <div key={b.batch_id}>
                    <BatchHeading batch={b} />
                    <BatchLiveProgressPanel batch={b} />
                  </div>
                ))}
                {done.length > 0 && (
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--text-secondary)",
                      marginTop: active.length > 0 ? 6 : 0,
                    }}
                  >
                    {t("clipAnalytics.batchStatus.recentlyCompleted")}
                  </div>
                )}
                {done.map((b) => (
                  <div key={b.batch_id}>
                    <BatchHeading batch={b} />
                    <BatchLiveProgressPanel batch={b} />
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}


function BatchHeading({ batch }: { batch: ClipPipelineBatch }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const submittedAt = new Date(batch.submitted_at);
  const submittedLabel = isNaN(submittedAt.getTime())
    ? batch.submitted_at
    : dt.formatDateTime(submittedAt);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        flexWrap: "wrap",
        marginBottom: 6,
      }}
    >
      <strong style={{ fontSize: 13 }}>{t("clipAnalytics.batchStatus.batchN", { id: batch.batch_id })}</strong>
      <span
        className="text-xs text-dim"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {submittedLabel}
      </span>
      <span className="text-xs text-dim">
        {batch.use_cases.map((u) => u.toUpperCase()).join(" · ")}
        {" · "}
        {batch.skip_existing ? t("clipAnalytics.banner.skipExisting") : t("clipAnalytics.banner.overwrite")}
      </span>
    </div>
  );
}


function ModeRow({
  value,
  active,
  onPick,
  title,
  subtitle,
  tone,
}: {
  value: BatchMode;
  active: boolean;
  onPick: () => void;
  title: string;
  subtitle: string;
  tone?: "warn";
}) {
  const accent = tone === "warn" ? "var(--danger)" : "var(--accent)";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onPick}
      style={{
        textAlign: "start",
        display: "flex",
        gap: 10,
        padding: 12,
        border: active
          ? `2px solid ${accent}`
          : "1px solid var(--border)",
        background: active
          ? "rgba(99,102,241,0.06)"
          : "var(--bg)",
        borderRadius: 12,
        cursor: "pointer",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: `2px solid ${active ? accent : "var(--border)"}`,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {active && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: accent,
            }}
          />
        )}
      </div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 13.5,
            color: active ? accent : "var(--text)",
          }}
        >
          {title}
        </div>
        <div
          className="text-xs"
          style={{ marginTop: 3, color: "var(--text-secondary)", lineHeight: 1.5 }}
        >
          {subtitle}
        </div>
      </div>
      <span hidden>{value}</span>
    </button>
  );
}

// ── PipelineBatchBanner ───────────────────────────────────────────────────
// Inline page-header banner that mirrors the live queue state of every
// active ``clip_pipeline`` batch. Replaces the legacy
// ``BatchProgressBanner`` (which read from ``useReprocessStatus`` — a
// dead code path now that submissions go through clip_pipeline).
//
// Counters come from ``useClipPipelineStatus``; this component just
// renders the aggregate. The X dismisses for the *current* set of
// batches; a freshly-submitted batch unhides automatically (see the
// dismiss bookkeeping in ``ClipAnalyticsPage``).

function PipelineBatchBanner({
  batches,
  onOpen,
  onDismiss,
}: {
  batches: ClipPipelineBatch[];
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // Aggregate counters across every visible active batch.
  const agg = batches.reduce(
    (acc, b) => {
      acc.total += b.total_jobs;
      acc.completed += b.completed_jobs;
      acc.skipped += b.skipped_jobs;
      acc.failed += b.failed_jobs;
      acc.cropping += b.cropping_now;
      acc.matching += b.matching_now;
      return acc;
    },
    {
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      cropping: 0,
      matching: 0,
    },
  );
  const finished = agg.completed + agg.skipped + agg.failed;
  const pct =
    agg.total > 0 ? Math.min(100, (finished / agg.total) * 100) : 0;

  // Union of every visible batch's UC + mode summary. With one batch
  // (the common case) this matches the modal exactly; with multiple
  // we collapse to "N batches".
  const headline =
    batches.length === 1 && batches[0]
      ? `${batches[0].use_cases.map((u) => u.toUpperCase()).join(" · ")} · ${
          batches[0].skip_existing
            ? t("clipAnalytics.banner.skipExisting")
            : t("clipAnalytics.banner.overwrite")
        }`
      : t("clipAnalytics.banner.activeBatches", { count: batches.length });

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        margin: "0 0 12px",
        padding: "12px 14px",
        borderRadius: "var(--radius)",
        background:
          "linear-gradient(90deg, rgba(139,92,246,0.10), rgba(59,130,246,0.10))",
        border: "1px solid rgba(99,102,241,0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
        }}
      >
        <Icon name="sparkles" size={14} />
        <strong>{t("clipAnalytics.banner.running")}</strong>
        <span
          className="mono"
          style={{ color: "var(--text-secondary)", fontSize: 12 }}
        >
          {t("clipAnalytics.banner.jobs", { done: finished, total: agg.total })}
        </span>
        <span style={{ flex: 1 }} />
        <span className="text-xs text-dim">{headline}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onOpen}
          title={t("clipAnalytics.banner.detailsTitle")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Icon name="activity" size={11} />
          {t("clipAnalytics.banner.details")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("clipAnalytics.banner.dismissAria")}
          title={t("clipAnalytics.banner.dismissTitle")}
          style={{
            appearance: "none",
            width: 26,
            height: 26,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-secondary)",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            marginInlineStart: 2,
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 999,
          background: "rgba(0,0,0,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background:
              "linear-gradient(90deg, #8b5cf6 0%, #6366f1 60%, #3b82f6 100%)",
            transition: "width 240ms ease",
          }}
        />
      </div>
      <div className="text-xs text-dim" style={{ display: "flex", gap: 12 }}>
        <span>
          {t("clipAnalytics.banner.completed")}: <strong>{agg.completed}</strong>
        </span>
        <span>·</span>
        <span>
          {t("clipAnalytics.banner.skipped")}: <strong>{agg.skipped}</strong>
        </span>
        {agg.failed > 0 && (
          <>
            <span>·</span>
            <span style={{ color: "var(--danger-text)" }}>
              {t("clipAnalytics.banner.failed")}: <strong>{agg.failed}</strong>
            </span>
          </>
        )}
        <span>·</span>
        <span>
          {t("clipAnalytics.banner.croppingMatching", { cropping: agg.cropping, matching: agg.matching })}
        </span>
      </div>
    </div>
  );
}



function IdentifyEventModal({
  clip,
  onClose,
}: {
  clip: PersonClipOut;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const reprocess = useSingleClipReprocess(clip.id);
  const qc = useQueryClient();
  const alreadyProcessed = new Set<UseCaseCode>(
    clip.processed_use_cases.filter((u): u is UseCaseCode =>
      (ALL_USE_CASES as readonly string[]).includes(u),
    ),
  );

  const [selected, setSelected] = useState<Set<UseCaseCode>>(new Set());
  const [step, setStep] = useState<IdentifyStep>("pick");
  const [error, setError] = useState<string | null>(null);

  const conflicts = Array.from(selected).filter((uc) =>
    alreadyProcessed.has(uc),
  );

  const toggle = (uc: UseCaseCode) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uc)) next.delete(uc);
      else next.add(uc);
      return next;
    });
  };

  const fire = async (useCases: UseCaseCode[]) => {
    setError(null);
    try {
      await reprocess.mutateAsync({ use_cases: useCases });
      // Refresh the list so the "Processed Use Cases" column updates
      // once the worker thread finishes.
      qc.invalidateQueries({ queryKey: ["clip-analytics", "list"] });
      onClose();
    } catch (e) {
      const message =
        e instanceof Error ? e.message : t("clipAnalytics.modal.errCouldNotStart");
      setError(message);
    }
  };

  const onProcessClick = () => {
    if (selected.size === 0) {
      setError(t("clipAnalytics.modal.errPickOne"));
      return;
    }
    if (conflicts.length > 0) {
      setStep("confirm-overwrite");
      return;
    }
    void fire(Array.from(selected));
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background:
            "linear-gradient(180deg, rgba(10,12,20,0.55), rgba(10,12,20,0.72))",
          backdropFilter: "blur(2px)",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("clipAnalytics.modal.identifyAria")}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "0 24px 64px rgba(10,12,20,0.35)",
            width: 720,
            maxWidth: "calc(100vw - 48px)",
            overflow: "hidden",
          }}
        >
          {step === "pick" ? (
            <PickStep
              clip={clip}
              selected={selected}
              alreadyProcessed={alreadyProcessed}
              onToggle={toggle}
              onCancel={onClose}
              onProcess={onProcessClick}
              busy={reprocess.isPending}
              error={error}
            />
          ) : (
            <OverwriteConfirmStep
              conflicts={conflicts}
              clip={clip}
              onCancel={() => setStep("pick")}
              onSkipExisting={() => {
                const fresh = Array.from(selected).filter(
                  (uc) => !alreadyProcessed.has(uc),
                );
                if (fresh.length === 0) {
                  setStep("pick");
                  setError(
                    t("clipAnalytics.modal.errNothingLeft"),
                  );
                  return;
                }
                void fire(fresh);
              }}
              onReprocessAll={() => void fire(Array.from(selected))}
              busy={reprocess.isPending}
              error={error}
            />
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function PickStep({
  clip,
  selected,
  alreadyProcessed,
  onToggle,
  onCancel,
  onProcess,
  busy,
  error,
}: {
  clip: PersonClipOut;
  selected: Set<UseCaseCode>;
  alreadyProcessed: Set<UseCaseCode>;
  onToggle: (uc: UseCaseCode) => void;
  onCancel: () => void;
  onProcess: () => void;
  busy: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const enabledUcs = useEnabledUseCases();
  return (
    <>
      <ModalHeader clip={clip} title={t("clipAnalytics.identifyEvent")} />

      <div style={{ padding: "18px 22px 6px" }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--text-secondary)",
            marginBottom: 10,
          }}
        >
          {t("clipAnalytics.pick.chooseUseCases")}
        </div>

        <div
          role="group"
          aria-label={t("clipAnalytics.pick.useCasesGroup")}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
          }}
        >
          {UC_TILES.filter((tile) =>
            (enabledUcs as readonly string[]).includes(tile.code),
          ).map((tile) => (
            <UseCaseCard
              key={tile.code}
              tile={tile}
              checked={selected.has(tile.code)}
              already={alreadyProcessed.has(tile.code)}
              onToggle={() => onToggle(tile.code)}
            />
          ))}
        </div>

        {error && (
          <div
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 12.5,
              marginTop: 14,
              border: "1px solid var(--danger, rgba(239,68,68,0.25))",
            }}
          >
            {error}
          </div>
        )}
      </div>

      <ModalFooter
        leftSlot={
          <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
            {selected.size === 0
              ? t("clipAnalytics.pick.noneSelected")
              : t("clipAnalytics.pick.nSelected", { count: selected.size })}
            {alreadyProcessed.size > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--success-text)" }}>
                  {t("clipAnalytics.pick.alreadyProcessed", { count: alreadyProcessed.size })}
                </span>
              </>
            )}
          </div>
        }
      >
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={busy}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onProcess}
          disabled={busy || selected.size === 0}
        >
          {busy ? t("clipAnalytics.pick.starting") : t("clipAnalytics.pick.process")}
        </button>
      </ModalFooter>
    </>
  );
}

function OverwriteConfirmStep({
  conflicts,
  clip,
  onCancel,
  onSkipExisting,
  onReprocessAll,
  busy,
  error,
}: {
  conflicts: UseCaseCode[];
  clip: PersonClipOut;
  onCancel: () => void;
  onSkipExisting: () => void;
  onReprocessAll: () => void;
  busy: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const conflictList = conflicts.map((u) => u.toUpperCase());
  return (
    <>
      <ModalHeader
        clip={clip}
        title={t("clipAnalytics.overwrite.title")}
        tone="warning"
        iconName="info"
      />

      <div style={{ padding: "20px 22px 4px" }}>
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          {conflictList.map((code) => (
            <span
              key={code}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 999,
                background: "var(--success-soft)",
                color: "var(--success-text)",
                border: "1px solid rgba(16,185,129,0.25)",
              }}
            >
              <Icon name="check" size={12} />
              {code}
            </span>
          ))}
        </div>
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "var(--text)",
          }}
        >
          {conflicts.length === 1
            ? t("clipAnalytics.overwrite.single", { uc: conflictList[0] })
            : t("clipAnalytics.overwrite.multi", { ucs: conflictList.join(", ") })}
        </div>

        {error && (
          <div
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 12.5,
              marginTop: 14,
              border: "1px solid var(--danger, rgba(239,68,68,0.25))",
            }}
          >
            {error}
          </div>
        )}
      </div>

      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={busy}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={onSkipExisting}
          disabled={busy}
        >
          {t("clipAnalytics.overwrite.skipExisting")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          style={{ background: "var(--danger)", color: "white" }}
          onClick={onReprocessAll}
          disabled={busy}
        >
          {busy
            ? t("clipAnalytics.pick.starting")
            : conflicts.length === 1
              ? t("clipAnalytics.overwrite.reprocessOne")
              : t("clipAnalytics.overwrite.reprocessMany")}
        </button>
      </ModalFooter>
    </>
  );
}

// ---- Modal sub-pieces ----

function ModalHeader({
  clip,
  title,
  tone,
  iconName,
}: {
  clip: PersonClipOut;
  title: string;
  tone?: "default" | "warning";
  iconName?: IconName;
}) {
  const { t } = useTranslation();
  const accentBg =
    tone === "warning"
      ? "linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)"
      : "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 50%, #10b981 100%)";
  const headerIcon: IconName = iconName ?? "user";
  return (
    <div
      style={{
        padding: "22px 22px 18px",
        background: accentBg,
        color: "white",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            background: "rgba(255,255,255,0.18)",
            display: "grid",
            placeItems: "center",
            border: "1px solid rgba(255,255,255,0.25)",
          }}
        >
          <Icon name={headerIcon} size={20} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              opacity: 0.85,
            }}
          >
            {t("clipAnalytics.title")}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
            {title}
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <SummaryChip iconName="camera" label={clip.camera_name || t("clipAnalytics.unknown")} />
        <SummaryChip iconName="fileText" mono label={clip.clip_name || `clip-${clip.id}`} />
        <SummaryChip
          iconName="clock"
          mono
          label={fmtDuration(clip.duration_seconds)}
        />
        <SummaryChip
          iconName="download"
          mono
          label={fmtBytes(clip.filesize_bytes)}
        />
      </div>
    </div>
  );
}

function SummaryChip({
  iconName,
  label,
  mono,
}: {
  iconName: IconName;
  label: string;
  mono?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.18)",
        border: "1px solid rgba(255,255,255,0.22)",
        color: "white",
        fontSize: 12,
        fontFamily: mono
          ? "var(--font-mono, ui-monospace, SFMono-Regular, monospace)"
          : undefined,
        fontWeight: 500,
      }}
    >
      <Icon name={iconName} size={12} />
      {label}
    </span>
  );
}

function UseCaseCard({
  tile,
  checked,
  already,
  onToggle,
}: {
  tile: UseCaseTile;
  checked: boolean;
  already: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      style={{
        textAlign: "start",
        background: checked ? tile.accentSoft : "var(--bg)",
        border: checked
          ? `2px solid ${tile.accent}`
          : "1px solid var(--border)",
        borderRadius: 14,
        padding: 14,
        cursor: "pointer",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        transition: "transform 100ms ease, box-shadow 100ms ease",
        boxShadow: checked
          ? `0 8px 24px ${tile.accentSoft}`
          : "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      {already && (
        <span
          style={{
            position: "absolute",
            top: 10,
            insetInlineEnd: 10,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            background: "var(--success-soft)",
            color: "var(--success-text)",
            border: "1px solid rgba(16,185,129,0.25)",
          }}
        >
          <Icon name="check" size={10} />
          {t("clipAnalytics.card.processedBadge")}
        </span>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingInlineEnd: already ? 70 : 0,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: checked ? tile.accent : tile.accentSoft,
            color: checked ? "white" : tile.accent,
            display: "grid",
            placeItems: "center",
            transition: "background 100ms ease, color 100ms ease",
          }}
        >
          <Icon name={tile.iconName} size={16} />
        </div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: checked ? tile.accent : "var(--text)",
          }}
        >
          {tile.code.toUpperCase()}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {tile.title}
        </div>
        <div
          className="text-xs"
          style={{ marginTop: 4, color: "var(--text-secondary)", lineHeight: 1.5 }}
        >
          {t(`clipAnalytics.tiles.${tile.code}.subtitle`, { defaultValue: tile.subtitle })}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <SpeedChip
          label={t(`clipAnalytics.tiles.${tile.code}.speed`, { defaultValue: tile.speedLabel })}
          tone={tile.speedTone}
        />
        <span
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11,
            background: "var(--bg-elev, var(--bg))",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
          }}
        >
          {t(`clipAnalytics.tiles.${tile.code}.accuracy`, { defaultValue: tile.accuracyLabel })}
        </span>
      </div>

      <div
        aria-hidden
        style={{
          position: "absolute",
          insetInlineStart: 0,
          top: 0,
          bottom: 0,
          width: 4,
          background: checked ? tile.accent : "transparent",
          borderStartStartRadius: 14,
          borderEndStartRadius: 14,
        }}
      />
    </button>
  );
}

function SpeedChip({
  label,
  tone,
}: {
  label: string;
  tone: "fast" | "balanced" | "thorough";
}) {
  const palette: Record<typeof tone, { bg: string; fg: string }> = {
    fast: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
    balanced: { bg: "rgba(139,92,246,0.12)", fg: "#6d28d9" },
    thorough: { bg: "rgba(59,130,246,0.12)", fg: "#1d4ed8" },
  } as const;
  const { bg, fg } = palette[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: bg,
        color: fg,
      }}
    >
      <Icon name="activity" size={10} />
      {label}
    </span>
  );
}

function ModalFooter({
  children,
  leftSlot,
}: {
  children: React.ReactNode;
  leftSlot?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "14px 22px 18px",
        borderTop: "1px solid var(--border)",
        marginTop: 14,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>{leftSlot}</div>
      <div style={{ display: "flex", gap: 8 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation modal.
// ---------------------------------------------------------------------------

function DeleteClipModal({
  clip,
  onClose,
}: {
  clip: PersonClipOut;
  onClose: () => void;
}) {
  const del = useDeletePersonClip();
  return (
    <DeleteClipsDialog
      count={1}
      clips={[clip]}
      onCancel={onClose}
      onDelete={async () => {
        await del.mutateAsync(clip.id);
        return { deleted: 1, skipped: 0 };
      }}
      onDone={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Live Processing modal — full real-time view of a clip's processing
// state. Opened by clicking the Processing Status pill.
//
// Polls aggressively (1.5 s) for clips actively being processed; falls
// back to 5 s once everything has reached a terminal state.
// ---------------------------------------------------------------------------

type UcCode = "uc1" | "uc2";

const UC_LIVE_META: Record<UcCode, { label: string; accent: string; accentSoft: string }> = {
  uc1: { label: "Use Case 1 (High Accuracy)", accent: "#3b82f6", accentSoft: "rgba(59,130,246,0.12)" },
  uc2: { label: "Use Case 2 (Standard)", accent: "#8b5cf6", accentSoft: "rgba(139,92,246,0.12)" },
};

function LiveProcessingModal({
  clip,
  onClose,
}: {
  clip: PersonClipOut;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  // Poll the parent clip row every 2 s so the recording_status +
  // face_matching_progress fields stay fresh. The list query has its
  // own 10 s poll, but the modal needs finer granularity.
  const clipRow = useQuery({
    queryKey: ["clip-analytics", "live", clip.id],
    queryFn: () => api<PersonClipOut>(`/api/person-clips/${clip.id}`),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    initialData: clip,
  });
  const live = clipRow.data ?? clip;

  // Per-UC progress rows + face crops. The hooks self-poll while
  // anything is still processing/pending.
  const results = useClipProcessingResults(clip.id, true);
  const uc1Crops = useClipFaceCrops(clip.id, "uc1");
  const uc2Crops = useClipFaceCrops(clip.id, "uc2");

  const ucResults = results.data?.results ?? [];
  const uc1 = ucResults.find((r) => r.use_case === "uc1") ?? null;
  const uc2 = ucResults.find((r) => r.use_case === "uc2") ?? null;

  // Esc to close.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  // Compute the current overall stage. Order: Recording → Finalizing →
  // Face Extraction → Face Matching → Completed. Failed wins over all.
  const overallStage = computeOverallStage(live, ucResults);
  const totalElapsed = computeTotalElapsedMs(live, ucResults);

  // Drop any cached UC list once everything is done so the next open
  // doesn't show stale numbers if reprocess fires.
  useEffect(() => {
    return () => {
      qc.invalidateQueries({ queryKey: ["person-clips", "processing-results", clip.id] });
    };
  }, [clip.id, qc]);

  const isInFlight =
    overallStage.state !== "completed" && overallStage.state !== "failed";

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background:
            "linear-gradient(180deg, rgba(10,12,20,0.55), rgba(10,12,20,0.72))",
          backdropFilter: "blur(2px)",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("clipAnalytics.live.aria")}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "0 24px 64px rgba(10,12,20,0.35)",
            width: 920,
            maxWidth: "calc(100vw - 48px)",
            maxHeight: "calc(100vh - 48px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Hero header. Pulse dot when live; static otherwise. */}
          <div
            style={{
              padding: "20px 22px 16px",
              background: isInFlight
                ? "linear-gradient(135deg, #ef4444 0%, #f59e0b 60%, #8b5cf6 100%)"
                : "linear-gradient(135deg, #10b981 0%, #3b82f6 100%)",
              color: "white",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                aria-hidden
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.18)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Icon name="activity" size={20} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    opacity: 0.85,
                  }}
                >
                  {isInFlight && <LiveDot />}
                  {t("clipAnalytics.live.eyebrow")}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
                  {t(`clipAnalytics.live.stage.${overallStage.labelKey}`)}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("common.close")}
                style={{
                  background: "rgba(255,255,255,0.18)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  color: "white",
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  cursor: "pointer",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            <div
              style={{
                marginTop: 14,
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <SummaryChip iconName="camera" label={clip.camera_name || "—"} />
              <SummaryChip
                iconName="fileText"
                mono
                label={clip.clip_name || `clip-${clip.id}`}
              />
              <SummaryChip
                iconName="clock"
                mono
                label={`#${clip.id}`}
              />
            </div>
          </div>

          {/* Body — scroll within the modal so the header stays pinned. */}
          <div style={{ overflow: "auto", padding: "16px 22px 22px" }}>
            {/* Overall pipeline */}
            <SectionLabelLive>{t("clipAnalytics.live.pipeline")}</SectionLabelLive>
            <StageTrack stage={overallStage.state} live={live} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 8,
                marginTop: 10,
              }}
            >
              <LiveKpi
                label={t("clipAnalytics.live.totalElapsed")}
                value={totalElapsed != null ? fmtElapsedMs(totalElapsed) : "—"}
              />
              <LiveKpi
                label={t("clipAnalytics.live.recordingStatus")}
                value={live.recording_status}
              />
              <LiveKpi
                label={t("clipAnalytics.live.matchingStatus")}
                value={live.matched_status}
              />
              <LiveKpi
                label={t("clipAnalytics.live.matchProgress")}
                value={`${live.face_matching_progress ?? 0}%`}
              />
            </div>

            {/* Per-UC tracks */}
            <SectionLabelLive style={{ marginTop: 18 }}>
              {t("clipAnalytics.live.perUseCase")}
            </SectionLabelLive>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 12,
              }}
            >
              <UcLiveCard ucCode="uc1" result={uc1} cropsCount={uc1Crops.data?.total ?? 0} />
              <UcLiveCard ucCode="uc2" result={uc2} cropsCount={uc2Crops.data?.total ?? 0} />
            </div>

            {/* Detected/matched persons */}
            {hasAnyMatchDetails(ucResults) && (
              <>
                <SectionLabelLive style={{ marginTop: 18 }}>
                  {t("clipAnalytics.live.detectedPersons")}
                </SectionLabelLive>
                <MatchConfidenceList ucResults={ucResults} />
              </>
            )}

            {/* Live face crops */}
            {(uc1Crops.data?.items ?? uc2Crops.data?.items) && (() => {
              const allCrops = [
                ...(uc1Crops.data?.items ?? []),
                ...(uc2Crops.data?.items ?? []),
              ];
              return (
                <>
                  <SectionLabelLive style={{ marginTop: 18 }}>
                    {t("clipAnalytics.live.faceCropsLatest")}
                  </SectionLabelLive>
                  <AnomalyInfoBanner message={t("clipAnalytics.live.anomalyNote")} />
                  <LiveCropsStrip clipId={clip.id} crops={allCrops} />
                </>
              );
            })()}

            {/* Errors */}
            {anyUcFailed(ucResults) && (
              <div
                style={{
                  marginTop: 18,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  border: "1px solid rgba(239,68,68,0.25)",
                  fontSize: 12.5,
                }}
              >
                <strong>{t("clipAnalytics.live.errors")}</strong>{" "}
                {ucResults
                  .filter((r) => r.status === "failed" && r.error)
                  .map((r) => `${r.use_case.toUpperCase()}: ${r.error}`)
                  .join(" · ")}
              </div>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---- Overall stage computation ----

type OverallStageState =
  | "recording"
  | "encoding"
  | "extracting"
  | "matching"
  | "completed"
  | "failed";

function computeOverallStage(
  clip: PersonClipOut,
  ucs: ClipProcessingResult[],
  // Pure helper (no ``t`` in scope) — returns an i18n key suffix under
  // ``clipAnalytics.live.stage.*``; the caller translates it.
): { state: OverallStageState; labelKey: string } {
  if (clip.recording_status === "failed" || clip.recording_status === "abandoned") {
    return { state: "failed", labelKey: "recordingFailed" };
  }
  if (ucs.some((r) => r.status === "failed")) {
    return { state: "failed", labelKey: "processingFailed" };
  }
  if (clip.recording_status === "recording") {
    return { state: "recording", labelKey: "recordingFromCamera" };
  }
  if (clip.recording_status === "finalizing") {
    return { state: "encoding", labelKey: "finalizingMp4" };
  }
  // Recording is completed. Inspect the UC pipeline.
  const anyProcessing = ucs.some((r) => r.status === "processing");
  if (anyProcessing) {
    // Heuristic: if any UC has finished extraction but not match, we're
    // in the matching phase; otherwise extraction.
    const extracting = ucs.some(
      (r) => r.status === "processing" && (r.face_extract_duration_ms ?? 0) === 0,
    );
    if (extracting) {
      return { state: "extracting", labelKey: "faceExtraction" };
    }
    return { state: "matching", labelKey: "faceMatching" };
  }
  const anyPending = ucs.some((r) => r.status === "pending");
  if (anyPending) {
    return { state: "extracting", labelKey: "queuedExtraction" };
  }
  if (ucs.length > 0 && ucs.every((r) => r.status === "completed")) {
    return { state: "completed", labelKey: "processingComplete" };
  }
  // Saved but no UC has been run yet.
  return { state: "completed", labelKey: "savedNoUc" };
}

function computeTotalElapsedMs(
  clip: PersonClipOut,
  ucs: ClipProcessingResult[],
): number | null {
  // While recording: elapsed = now - clip_start.
  if (clip.recording_status === "recording") {
    const ts = Date.parse(clip.clip_start);
    return Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
  }
  // While finalizing: elapsed = now - encoding_start_at (fall back to clip_end).
  if (clip.recording_status === "finalizing") {
    const anchor = clip.encoding_start_at ?? clip.clip_end;
    const ts = Date.parse(anchor);
    return Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
  }
  // Otherwise sum the UC durations that have landed.
  const total = ucs.reduce((acc, r) => acc + (r.duration_ms ?? 0), 0);
  return total > 0 ? total : null;
}

function anyUcFailed(ucs: ClipProcessingResult[]): boolean {
  return ucs.some((r) => r.status === "failed");
}

function hasAnyMatchDetails(ucs: ClipProcessingResult[]): boolean {
  return ucs.some(
    (r) =>
      Array.isArray(r.match_details) &&
      r.match_details.length > 0,
  );
}

// ---- Live primitives ----

function LiveDot() {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 0 0 0 rgba(255,255,255,0.7)",
        animation: "live-processing-pulse 1.4s ease-in-out infinite",
      }}
    />
  );
}

function SectionLabelLive({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 11.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-secondary)",
        marginBottom: 10,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function StageTrack({
  stage,
  live,
}: {
  stage: OverallStageState;
  live: PersonClipOut;
}) {
  const { t } = useTranslation();
  // Stage order for the track. Recording is excluded from the
  // "post-record" track since the clip can only enter processing
  // after recording is complete.
  const stages: { key: OverallStageState; label: string; icon: IconName }[] = [
    { key: "recording", label: t("clipAnalytics.live.track.recording"), icon: "videocam" },
    { key: "encoding", label: t("clipAnalytics.live.track.finalizing"), icon: "activity" },
    { key: "extracting", label: t("clipAnalytics.live.track.extraction"), icon: "user" },
    { key: "matching", label: t("clipAnalytics.live.track.matching"), icon: "shield" },
    { key: "completed", label: t("clipAnalytics.live.track.completed"), icon: "check" },
  ];
  const reachedIndex = stages.findIndex((s) => s.key === stage);
  const isFailed = stage === "failed";

  const successColor = "var(--success-text)";
  const accentColor = "var(--accent, #6366f1)";
  const mutedColor = "var(--text-secondary)";
  const lineMuted = "var(--border)";
  return (
    <div
      style={{
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "18px 16px 14px",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${stages.length}, 1fr)`,
          gap: 0,
          position: "relative",
        }}
      >
        {stages.map((s, i) => {
          const active = i === reachedIndex && !isFailed;
          const past = !isFailed && i < reachedIndex;
          const segmentDone = !isFailed && i < reachedIndex; // connector to next
          const ringColor = past ? successColor : active ? accentColor : lineMuted;
          const fillColor = past ? successColor : active ? accentColor : "transparent";
          const iconColor = past || active ? "#fff" : mutedColor;
          const labelColor = active ? accentColor : past ? successColor : mutedColor;
          return (
            <div
              key={s.key}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                position: "relative",
              }}
            >
              {/* Connector line — drawn from this circle's right to the
                  next circle's left. Green when this stage is completed. */}
              {i < stages.length - 1 && (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 10, // ~ vertical center of 22px circle
                    left: "calc(50% + 14px)",
                    right: "calc(-50% + 14px)",
                    height: 3,
                    background: segmentDone ? successColor : lineMuted,
                    zIndex: 0,
                    transition: "background 200ms ease",
                  }}
                />
              )}
              {/* Circle: green-filled w/ white tick when past, accent-filled
                  when active, neutral outline when future. */}
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  border: `2px solid ${ringColor}`,
                  color: iconColor,
                  display: "grid",
                  placeItems: "center",
                  background: fillColor,
                  position: "relative",
                  zIndex: 1,
                  boxShadow: active
                    ? `0 0 0 4px rgba(99,102,241,0.15)`
                    : past
                      ? `0 0 0 3px rgba(34,197,94,0.12)`
                      : "none",
                  transition: "background 200ms ease, border-color 200ms ease",
                }}
              >
                <Icon name={past ? "check" : s.icon} size={11} />
              </span>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: labelColor,
                    letterSpacing: "0.02em",
                    textAlign: "center",
                  }}
                >
                  {s.label}
                </span>
                {active && stage === "matching" && (
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    {live.face_matching_progress ?? 0}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiveKpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-secondary)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

function UcLiveCard({
  ucCode,
  result,
  cropsCount,
}: {
  ucCode: UcCode;
  result: ClipProcessingResult | null;
  cropsCount: number;
}) {
  const { t } = useTranslation();
  const meta = UC_LIVE_META[ucCode];
  const status = result?.status ?? "idle";
  const statusTone: Record<string, { bg: string; fg: string; label: string }> = {
    pending: { bg: "var(--warning-soft)", fg: "var(--warning-text)", label: t("clipAnalytics.live.ucStatus.pending") },
    processing: { bg: "rgba(99,102,241,0.12)", fg: "#4338ca", label: t("clipAnalytics.live.ucStatus.processing") },
    completed: { bg: "var(--success-soft)", fg: "var(--success-text)", label: t("clipAnalytics.live.ucStatus.completed") },
    failed: { bg: "var(--danger-soft)", fg: "var(--danger-text)", label: t("clipAnalytics.live.ucStatus.failed") },
    idle: { bg: "var(--bg-sunken)", fg: "var(--text-secondary)", label: t("clipAnalytics.live.ucStatus.idle") },
  };
  const sp = statusTone[status] ?? statusTone.idle!;
  const isLive = status === "processing" || status === "pending";

  // Live elapsed when processing: now - started_at (if available).
  const liveElapsedMs = (() => {
    if (status !== "processing") return null;
    if (!result?.started_at) return null;
    const t = Date.parse(result.started_at);
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
  })();

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          background: meta.accentSoft,
          borderBottom: `2px solid ${meta.accent}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: meta.accent,
            letterSpacing: "0.02em",
          }}
        >
          {ucCode.toUpperCase()}
        </div>
        <div
          className="text-xs"
          style={{
            color: "var(--text-secondary)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {meta.label}
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 10.5,
            fontWeight: 700,
            background: sp.bg,
            color: sp.fg,
          }}
        >
          {isLive && <LiveDot />}
          {sp.label}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 1,
          background: "var(--border)",
        }}
      >
        <UcStat label={t("clipAnalytics.live.ucStat.extract")} value={fmtMaybeMs(result?.face_extract_duration_ms)} />
        <UcStat label={t("clipAnalytics.live.ucStat.match")} value={fmtMaybeMs(result?.match_duration_ms)} />
        <UcStat
          label={t("clipAnalytics.live.ucStat.total")}
          value={
            status === "processing" && liveElapsedMs != null
              ? `${fmtElapsedMs(liveElapsedMs)}…`
              : fmtMaybeMs(result?.duration_ms)
          }
        />
        <UcStat label={t("clipAnalytics.live.ucStat.crops")} value={String(cropsCount)} />
        <UcStat
          label={t("clipAnalytics.live.ucStat.matched")}
          value={String(result?.matched_employees.length ?? 0)}
          accent="var(--success-text)"
        />
        <UcStat
          label={t("clipAnalytics.live.ucStat.unknown")}
          value={String(result?.unknown_count ?? 0)}
        />
      </div>
      {result?.matched_employee_names && result.matched_employee_names.length > 0 && (
        <div
          style={{
            padding: "8px 10px",
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            background: "var(--bg-elev)",
            borderTop: "1px solid var(--border)",
          }}
        >
          {result.matched_employee_names.slice(0, 4).map((n, i) => (
            <span
              key={i}
              style={{
                padding: "1px 6px",
                borderRadius: 999,
                fontSize: 10.5,
                fontWeight: 600,
                background: meta.accentSoft,
                color: meta.accent,
                border: `1px solid ${meta.accent}33`,
              }}
            >
              {n}
            </span>
          ))}
          {result.matched_employee_names.length > 4 && (
            <span className="text-xs text-dim">
              +{result.matched_employee_names.length - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function UcStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--bg)" }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: accent ?? "var(--text)",
          marginTop: 1,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MatchConfidenceList({ ucResults }: { ucResults: ClipProcessingResult[] }) {
  const { t } = useTranslation();
  // Roll up best confidence per (employee, uc) across all results.
  type Entry = { name: string; employeeId: number | null; confidence: number; uc: string };
  const entries: Entry[] = [];
  for (const r of ucResults) {
    if (!Array.isArray(r.match_details)) continue;
    for (const md of r.match_details as Array<{
      employee_id?: number;
      employee_name?: string;
      confidence?: number;
    }>) {
      if (typeof md.confidence !== "number") continue;
      entries.push({
        name: md.employee_name ?? t("clipAnalytics.live.employeeN", { id: md.employee_id ?? "?" }),
        employeeId: typeof md.employee_id === "number" ? md.employee_id : null,
        confidence: md.confidence,
        uc: r.use_case,
      });
    }
  }
  entries.sort((a, b) => b.confidence - a.confidence);

  if (entries.length === 0) {
    return (
      <div className="text-sm text-dim" style={{ padding: "8px 0" }}>
        {t("clipAnalytics.live.noMatchDetails")}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {entries.slice(0, 20).map((e, i) => {
        const meta = UC_LIVE_META[e.uc as UcCode];
        const pct = Math.round(e.confidence * 100);
        return (
          <span
            key={i}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: 999,
              fontSize: 11.5,
              background: meta?.accentSoft ?? "var(--bg-sunken)",
              color: meta?.accent ?? "var(--text)",
              border: `1px solid ${meta?.accent ?? "var(--border)"}33`,
            }}
          >
            <span style={{ fontWeight: 600 }}>{e.name}</span>
            <span className="mono" style={{ fontSize: 10.5 }}>
              {pct}% · {e.uc.toUpperCase()}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function LiveCropsStrip({
  clipId,
  crops,
}: {
  clipId: number;
  crops: FaceCropOut[];
}) {
  const { t } = useTranslation();
  // Most recent first; cap to 20 for the modal strip.
  const sorted = [...crops]
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  if (sorted.length === 0) {
    return (
      <div className="text-sm text-dim" style={{ padding: "8px 0" }}>
        {t("clipAnalytics.live.noCrops")}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
        gap: 6,
      }}
    >
      {sorted.map((c) => (
        <div
          key={c.id}
          title={
            c.employee_name
              ? `${c.employee_name} · Q${c.quality_score.toFixed(2)}`
              : `${t("clipAnalytics.unknown")} · Q${c.quality_score.toFixed(2)}`
          }
          style={{
            position: "relative",
            aspectRatio: "1",
            background: "#111",
            borderRadius: 6,
            overflow: "hidden",
            border: c.employee_id
              ? "2px solid var(--success-text)"
              : "1px solid var(--border)",
          }}
        >
          <img
            src={`/api/person-clips/${clipId}/face-crops/${c.id}/image`}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",

            }}
          />
          {c.use_case && (
            <span
              className="mono"
              style={{
                position: "absolute",
                top: 2,
                insetInlineStart: 2,
                padding: "0 4px",
                background: "rgba(0,0,0,0.6)",
                color: "#fff",
                fontSize: 9,
                borderRadius: 2,
              }}
            >
              {c.use_case.toUpperCase()}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}


function fmtMaybeMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtElapsedMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

// Keyframes for the LiveDot pulse — injected once.
if (typeof document !== "undefined") {
  const id = "live-processing-keyframes";
  if (!document.getElementById(id)) {
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `@keyframes live-processing-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.7); }
      50% { box-shadow: 0 0 0 4px rgba(255,255,255,0); }
    }`;
    document.head.appendChild(s);
  }
}
