// Clip Analytics — minimal table of saved person event clips, with
// a per-row action menu (Edit / Delete / Identify Event).
//
// Deliberately separate from the heavy PersonClipsPage. This page is
// purely: "person was detected → clip was saved → row appears here".
//
// Face matching, face crop extraction, and UC comparison are manual:
// click ⋮ → "Identify Event" → pick UC1 / UC2 to process.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api/client";
import { AnomalyInfoBanner } from "../../components/AnomalyNote";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { dayBound, useTenantDateTime } from "../../util/datetime";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { Pagination } from "../../components/Pagination";
import type { IconName } from "../../shell/Icon";
import { useCameras } from "../cameras/hooks";
import {
  useClipFaceCrops,
  useClipProcessingResults,
  useDeletePersonClip,
  useClipPipelineBatch,
  useClipPipelineStatus,
  useClipPipelineSubmitAll,
  useProcessedClipCounts,
  useReconcileNow,
  useReconcileStatus,
  useReprocessStatus,
  useRetryFailed,
  useSingleClipReprocess,
} from "../person-clips/hooks";
import type { ClipPipelineBatch } from "../person-clips/hooks";
import { ClipDetailDrawer } from "../person-clips/PersonClipsPage";
import { useEnabledUseCases } from "../../hooks/useEnabledUseCases";
import type {
  ClipProcessingResult,
  FaceCropOut,
  PersonClipListResponse,
  PersonClipOut,
} from "../person-clips/types";

const PAGE_SIZE = 50;
const BULK_DELETE_CAP = 200;

type ProcessingFilter =
  | "all"
  | "recording"
  | "encoding"
  | "processing"
  | "saved"
  | "processed";

type ProcessedUcFilter = "any" | "uc1" | "uc2" | "not_processed";

const ALL_USE_CASES = ["uc1", "uc2"] as const;
type UseCaseCode = (typeof ALL_USE_CASES)[number];

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

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
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
      return "abandoned";
    case "completed":
    default:
      if ((c.processing_use_cases ?? []).length > 0) return "processing";
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

// Match Result column — separate from Processed UCs so the operator
// can read pipeline progress (left) and match outcome (right) without
// either signal hiding the other.
//
// Data shape note: ``matched_employees`` is aggregated across every UC
// that has run for this clip — the backend doesn't currently expose a
// per-UC breakdown. So:
//   * If at least one employee matched → every UC in
//     ``processed_use_cases`` is rendered as a green "matched" pill.
//   * If no employee matched → every UC in ``processed_use_cases`` is
//     rendered as a red "unmatched" pill.
//   * UCs that haven't run yet show as neutral "pending" pills so the
//     cell always lists the full UC roster.
//
// The summary line under the pills carries the head-count (when
// matched) or a plain "No matches found" note (when unmatched).
function MatchResultCell({ clip }: { clip: PersonClipOut }) {
  const { t } = useTranslation();
  const enabled = useEnabledUseCases();
  if (clip.recording_status !== "completed") {
    return (
      <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>—</span>
    );
  }
  // Restrict to the tenant's enabled use cases so a disabled UC never
  // appears (matched, unmatched, or pending).
  const processed = clip.processed_use_cases.filter((u) =>
    (enabled as readonly string[]).includes(u),
  );
  const processing = (clip.processing_use_cases ?? []).filter((u) =>
    (enabled as readonly string[]).includes(u),
  );
  const matchedCount = clip.matched_employees.length;

  // Nothing has run and nothing is in flight — surface a neutral
  // "Pending" so the cell stays readable instead of empty.
  if (processed.length === 0 && processing.length === 0) {
    return (
      <span
        style={{
          fontSize: 12,
          color: "var(--text-tertiary)",
          fontStyle: "italic",
        }}
      >
        {t("clipAnalytics.match.pendingNotRun")}
      </span>
    );
  }

  // Same overall verdict applies to every UC that has run, given the
  // aggregated ``matched_employees`` shape.
  const hasMatch = matchedCount > 0;
  const matchedUcs = hasMatch ? processed : [];
  const unmatchedUcs = hasMatch ? [] : processed;
  const pendingUcs = enabled.filter(
    (uc) => !processed.includes(uc) && !processing.includes(uc),
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
      }}
    >
      {matchedUcs.length > 0 && (
        <MatchRow
          label={t("clipAnalytics.match.matched")}
          ucs={matchedUcs}
          tone="success"
          glyph="✓"
        />
      )}
      {unmatchedUcs.length > 0 && (
        <MatchRow
          label={t("clipAnalytics.match.unmatched")}
          ucs={unmatchedUcs}
          tone="danger"
          glyph="✗"
        />
      )}
      {processing.length > 0 && (
        <MatchRow
          label={t("clipAnalytics.match.processing")}
          ucs={processing}
          tone="warning"
          glyph="⟳"
        />
      )}
      {pendingUcs.length > 0 && (
        <MatchRow
          label={t("clipAnalytics.match.pending")}
          ucs={pendingUcs}
          tone="neutral"
          glyph="—"
        />
      )}
      {processed.length > 0 && (
        <div
          style={{
            fontSize: 11,
            color: hasMatch ? "#047857" : "#b91c1c",
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {hasMatch
            ? t("clipAnalytics.match.employeesMatched", { count: matchedCount })
            : t("clipAnalytics.match.noneMatched")}
        </div>
      )}
    </div>
  );
}

function MatchRow({
  label,
  ucs,
  tone,
  glyph,
}: {
  label: string;
  ucs: readonly string[];
  tone: "success" | "danger" | "warning" | "neutral";
  glyph: string;
}) {
  const palette: Record<
    typeof tone,
    { bg: string; fg: string; border: string }
  > = {
    success: {
      bg: "rgba(16,185,129,0.12)",
      fg: "#047857",
      border: "rgba(16,185,129,0.35)",
    },
    danger: {
      bg: "rgba(220,38,38,0.10)",
      fg: "#b91c1c",
      border: "rgba(220,38,38,0.35)",
    },
    warning: {
      bg: "rgba(245,158,11,0.14)",
      fg: "#b45309",
      border: "rgba(245,158,11,0.4)",
    },
    neutral: {
      bg: "var(--bg-sunken)",
      fg: "var(--text-tertiary)",
      border: "var(--border)",
    },
  };
  const p = palette[tone];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: p.fg,
          minWidth: 78,
        }}
      >
        {label}
      </span>
      <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {ucs.map((uc) => (
          <span
            key={uc}
            title={`${uc.toUpperCase()} — ${label}`}
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
              style={{ minWidth: 9, textAlign: "center", fontSize: 9 }}
            >
              {glyph}
            </span>
            {uc.toUpperCase()}
          </span>
        ))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Processing Health Panel — aggregate reconcile sweep results + action buttons
// ---------------------------------------------------------------------------

import type { ReconcileTenantSummary } from "../person-clips/hooks";

function ProcessingHealthPanel({
  reconcileStatus,
  reconcileLoading,
  onReconcileNow,
  retryLoading,
  retryDone,
  onRetryFailed,
}: {
  reconcileStatus: Record<string, ReconcileTenantSummary> | null;
  reconcileLoading: boolean;
  onReconcileNow: () => void;
  retryLoading: boolean;
  retryDone: { clips_found: number; queued_jobs: number } | null;
  onRetryFailed: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Aggregate across all tenants visible to this user. In practice a
  // regular Admin sees only their own tenant schema; only a Super-Admin
  // sweeping multiple tenants gets multiple entries.
  const tenants = Object.entries(reconcileStatus ?? {});
  const totalSaved = tenants.reduce((s, [, t]) => s + t.saved_found, 0);
  const totalStuck = tenants.reduce((s, [, t]) => s + t.stuck_found, 0);
  const totalMissing = tenants.reduce((s, [, t]) => s + t.missing_files, 0);
  const lastRanAt =
    tenants.length > 0
      ? tenants.map(([, t]) => t.ran_at).sort().at(-1) ?? null
      : null;

  const hasIssues = totalSaved > 0 || totalStuck > 0 || totalMissing > 0;

  function fmtRelative(iso: string | null): string {
    if (!iso) return t("clipAnalytics.health.never");
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const diffS = Math.round((Date.now() - d.getTime()) / 1000);
    if (diffS < 60) return t("clipAnalytics.health.secAgo", { n: diffS });
    if (diffS < 3600)
      return t("clipAnalytics.health.minAgo", { n: Math.round(diffS / 60) });
    return t("clipAnalytics.health.hrAgo", { n: Math.round(diffS / 3600) });
  }

  return (
    <div
      style={{
        border: `1px solid ${hasIssues ? "rgba(245,158,11,0.4)" : "var(--border)"}`,
        borderRadius: "var(--radius-sm)",
        marginBottom: 12,
        background: hasIssues
          ? "rgba(245,158,11,0.04)"
          : "var(--bg)",
        overflow: "hidden",
      }}
    >
      {/* Summary row — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: "8px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "start",
        }}
        aria-expanded={expanded}
        aria-label={t("clipAnalytics.health.toggleAria")}
      >
        <Icon
          name={expanded ? "chevronDown" : "chevronRight"}
          size={12}
        />
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>
          {t("clipAnalytics.health.title")}
        </span>
        {hasIssues ? (
          <span
            style={{
              fontSize: 11,
              color: "#b45309",
              background: "rgba(245,158,11,0.14)",
              border: "1px solid rgba(245,158,11,0.4)",
              borderRadius: 999,
              padding: "1px 7px",
              fontWeight: 600,
            }}
          >
            {[
              totalSaved > 0 && t("clipAnalytics.health.badge.unprocessed", { count: totalSaved }),
              totalStuck > 0 && t("clipAnalytics.health.badge.stuck", { count: totalStuck }),
              totalMissing > 0 && t("clipAnalytics.health.badge.missingFiles", { count: totalMissing }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : (
          <span
            style={{
              fontSize: 11,
              color: "#047857",
              background: "rgba(16,185,129,0.10)",
              border: "1px solid rgba(16,185,129,0.30)",
              borderRadius: 999,
              padding: "1px 7px",
              fontWeight: 600,
            }}
          >
            {t("clipAnalytics.health.allClear")}
          </span>
        )}
        <span
          style={{
            marginInlineStart: "auto",
            fontSize: 11,
            color: "var(--text-tertiary)",
          }}
        >
          {t("clipAnalytics.health.lastSweep", { rel: fmtRelative(lastRanAt) })}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: "0 14px 14px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            alignItems: "flex-start",
          }}
        >
          {/* Stat tiles */}
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              marginTop: 12,
            }}
          >
            {(
              [
                {
                  label: t("clipAnalytics.health.tiles.unprocessedSaved"),
                  value: totalSaved,
                  tone: totalSaved > 0 ? "warn" : "ok",
                  title: t("clipAnalytics.health.titles.unprocessed"),
                },
                {
                  label: t("clipAnalytics.health.tiles.stuckProcessing"),
                  value: totalStuck,
                  tone: totalStuck > 0 ? "warn" : "ok",
                  title: t("clipAnalytics.health.titles.stuck"),
                },
                {
                  label: t("clipAnalytics.health.tiles.missingFiles"),
                  value: totalMissing,
                  tone: totalMissing > 0 ? "danger" : "ok",
                  title: t("clipAnalytics.health.titles.missing"),
                },
              ] as const
            ).map(({ label, value, tone, title }) => (
              <div
                key={label}
                title={title}
                style={{
                  padding: "8px 14px",
                  borderRadius: "var(--radius-sm)",
                  border: `1px solid ${
                    tone === "danger"
                      ? "rgba(220,38,38,0.35)"
                      : tone === "warn"
                        ? "rgba(245,158,11,0.4)"
                        : "var(--border)"
                  }`,
                  background:
                    tone === "danger"
                      ? "rgba(220,38,38,0.07)"
                      : tone === "warn"
                        ? "rgba(245,158,11,0.07)"
                        : "var(--bg-sunken)",
                  minWidth: 130,
                }}
              >
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color:
                      tone === "danger"
                        ? "#b91c1c"
                        : tone === "warn"
                          ? "#b45309"
                          : "#047857",
                    lineHeight: 1.2,
                  }}
                >
                  {value}
                </div>
                <div
                  style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>

          {/* Per-tenant breakdown when multiple tenants */}
          {tenants.length > 1 && (
            <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-secondary)" }}>
              {tenants.map(([schema, tn]) => (
                <div key={schema} style={{ marginBottom: 4 }}>
                  <strong style={{ color: "var(--text)" }}>{schema}</strong>
                  {" — "}
                  {t("clipAnalytics.health.tenant", {
                    submitted: tn.saved_submitted,
                    stuck: tn.stuck_found,
                    missing: tn.missing_files,
                  })}
                  <span style={{ marginInlineStart: 8, color: "var(--text-tertiary)" }}>
                    ({fmtRelative(tn.ran_at)})
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button
              className="btn btn-sm"
              onClick={onReconcileNow}
              disabled={reconcileLoading}
              title={t("clipAnalytics.health.reconcileTitle")}
            >
              <Icon name="refresh" size={11} />
              {reconcileLoading ? t("clipAnalytics.health.reconcileRunning") : t("clipAnalytics.health.reconcileNow")}
            </button>
            <button
              className="btn btn-sm"
              onClick={onRetryFailed}
              disabled={retryLoading}
              title={t("clipAnalytics.health.retryTitle")}
            >
              <Icon name="activity" size={11} />
              {retryLoading ? t("clipAnalytics.health.retrying") : t("clipAnalytics.health.retryFailed")}
            </button>
            {retryDone !== null && (
              <span
                style={{
                  fontSize: 12,
                  color:
                    retryDone.clips_found > 0 ? "#047857" : "var(--text-secondary)",
                }}
              >
                {retryDone.clips_found === 0
                  ? t("clipAnalytics.health.noFailedClips")
                  : t("clipAnalytics.health.clipsFoundQueued", { found: retryDone.clips_found, queued: retryDone.queued_jobs })}
              </span>
            )}
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginInlineStart: 4 }}>
              {t("clipAnalytics.health.autoSweep")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ClipAnalyticsPage() {
  const { t } = useTranslation();
  const enabledUcs = useEnabledUseCases();
  // ---- server-driven filters ----
  const [page, setPage] = useState(1);
  const [cameraId, setCameraId] = useState<number | null>(null);
  const [processingFilter, setProcessingFilter] =
    useState<ProcessingFilter>("all");
  // Recording-mode filter: 'all' | 'save_clips' (incl. legacy NULL) |
  // 'logs_only'. Server-side via the /api/person-clips recording_mode param.
  const [recordingMode, setRecordingMode] =
    useState<"all" | "save_clips" | "logs_only">("all");
  const [startDate, setStartDate] = useState<string>(""); // YYYY-MM-DD
  const [endDate, setEndDate] = useState<string>("");

  // ---- client-side filters ----
  const [clipIdQ, setClipIdQ] = useState("");
  const [clipNameQ, setClipNameQ] = useState("");
  const [processedUcFilter, setProcessedUcFilter] =
    useState<ProcessedUcFilter>("any");

  // Whether any filter (server- or client-side) is currently narrowing
  // the list — drives the "Clear" button visibility.
  const hasActiveFilter =
    cameraId !== null ||
    processingFilter !== "all" ||
    recordingMode !== "all" ||
    startDate !== "" ||
    endDate !== "" ||
    clipIdQ !== "" ||
    clipNameQ !== "" ||
    processedUcFilter !== "any";

  function clearFilters() {
    setCameraId(null);
    setProcessingFilter("all");
    setRecordingMode("all");
    setStartDate("");
    setEndDate("");
    setClipIdQ("");
    setClipNameQ("");
    setProcessedUcFilter("any");
    setPage(1);
  }

  // ---- selection + modals ----
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [identifyTarget, setIdentifyTarget] = useState<PersonClipOut | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<PersonClipOut | null>(null);
  const [bulkDeleteScope, setBulkDeleteScope] = useState<
    "selected" | "all" | null
  >(null);
  const [detailTarget, setDetailTarget] = useState<PersonClipOut | null>(null);
  const [liveTarget, setLiveTarget] = useState<PersonClipOut | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  // ``Batch Process Status`` modal — surfaces the live progress of
  // any in-flight ``clip_pipeline`` batches (queue depth, completed
  // / skipped / failed counters, currently-processing clip/UC).
  // Distinct from ``batchOpen`` (the submit modal) — operators can
  // close the submit modal and still inspect progress via this one.
  const [statusOpen, setStatusOpen] = useState(false);
  const batchStatus = useReprocessStatus();
  const legacyBatchRunning =
    batchStatus.data?.status === "running" ||
    batchStatus.data?.status === "starting";
  // New queue-pipeline status — used both for the page-level "Batch
  // Process Status" button visibility and to know when to block a
  // fresh submit from the Identify Event button.
  const pipelineStatus = useClipPipelineStatus();
  const activeBatches = useMemo(
    () =>
      (pipelineStatus.data?.batches ?? []).filter(
        (b) => b.completed_at === null,
      ),
    [pipelineStatus.data],
  );
  const pipelineBatchRunning = activeBatches.length > 0;
  const batchRunning = legacyBatchRunning || pipelineBatchRunning;

  // ---- reconcile / processing-health panel ----
  const reconcileStatus = useReconcileStatus();
  const reconcileNow = useReconcileNow();
  const retryFailed = useRetryFailed();
  const [retryDone, setRetryDone] = useState<{
    clips_found: number;
    queued_jobs: number;
  } | null>(null);
  // The inline "Identify Event running…" banner under the page header
  // shows aggregate progress for every active pipeline batch the
  // operator has *not* dismissed. Dismissed ids live here so the
  // close button on the banner has somewhere to record its choice.
  // When no batch is active any more, the set resets so a fresh batch
  // brings the banner back without manual intervention.
  const [dismissedBatchIds, setDismissedBatchIds] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    if (activeBatches.length === 0 && dismissedBatchIds.size > 0) {
      setDismissedBatchIds(new Set());
    }
  }, [activeBatches.length, dismissedBatchIds.size]);
  const visibleActiveBatches = useMemo(
    () => activeBatches.filter((b) => !dismissedBatchIds.has(b.batch_id)),
    [activeBatches, dismissedBatchIds],
  );

  // Match Result column visibility. Hidden by default — operators
  // toggle it on/off via ``Ctrl + M``. The keystroke is ignored when
  // the focused element is editable (input / textarea / select /
  // contenteditable) so filter typing isn't hijacked.
  const [showMatchResult, setShowMatchResult] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt) {
        const tag = tgt.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tgt.isContentEditable
        ) {
          return;
        }
      }
      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === "m" || e.key === "M")
      ) {
        e.preventDefault();
        setShowMatchResult((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset to page 1 whenever any filter changes so the operator
  // doesn't land on an empty page 4.
  useEffect(() => {
    setPage(1);
  }, [cameraId, processingFilter, startDate, endDate]);

  // Build server query string. Camera + recording_status + start +
  // end are server-side. clip_name + processed-uc + saved-vs-processed
  // split is applied client-side because the backend doesn't expose
  // a processed_use_cases query param yet — but the server still
  // narrows by recording_status so the page set is small.
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("page_size", String(PAGE_SIZE));
    if (cameraId != null) p.set("camera_id", String(cameraId));
    if (processingFilter === "recording") {
      p.set("recording_status", "recording");
    } else if (processingFilter === "encoding") {
      p.set("recording_status", "finalizing");
    } else if (
      processingFilter === "saved"
      || processingFilter === "processed"
      || processingFilter === "processing"
    ) {
      // All three share recording_status='completed' — the client-side
      // filter below splits them on processing_use_cases /
      // processed_use_cases.
      p.set("recording_status", "completed");
    }
    if (recordingMode !== "all") p.set("recording_mode", recordingMode);
    // Day bounds in the viewer's local timezone (see dayBound). A lone
    // start date filters to ONLY that day; start+end is an inclusive range.
    if (startDate) p.set("start", dayBound(startDate, "00:00:00"));
    if (startDate && !endDate) {
      p.set("end", dayBound(startDate, "23:59:59"));
    } else if (endDate) {
      p.set("end", dayBound(endDate, "23:59:59"));
    }
    return p.toString();
  }, [page, cameraId, processingFilter, recordingMode, startDate, endDate]);

  const list = useQuery({
    queryKey: ["clip-analytics", "list", qs],
    queryFn: () => api<PersonClipListResponse>(`/api/person-clips?${qs}`),
    refetchInterval: 10_000,
  });

  const camerasQuery = useCameras();
  const bulkDelete = useBulkDeletePersonClips();

  // Apply the client-side filters AFTER the server response.
  //  * clip-name search (no backend index)
  //  * Saved vs Processed (split of recording_status='completed' rows
  //    by whether processed_use_cases is empty or not)
  //  * Processed-UC dropdown
  const items = useMemo(() => {
    let rows = list.data?.items ?? [];
    if (processingFilter === "processing") {
      rows = rows.filter(
        (c) =>
          c.recording_status === "completed" &&
          (c.processing_use_cases ?? []).length > 0,
      );
    } else if (processingFilter === "saved") {
      // Saved = completed recording, nothing in flight, nothing
      // finished — i.e. just sitting waiting for the operator.
      rows = rows.filter(
        (c) =>
          c.recording_status === "completed" &&
          (c.processing_use_cases ?? []).length === 0 &&
          c.processed_use_cases.length === 0,
      );
    } else if (processingFilter === "processed") {
      rows = rows.filter(
        (c) =>
          c.recording_status === "completed" &&
          c.processed_use_cases.length > 0,
      );
    }
    const idQ = clipIdQ.trim();
    if (idQ) {
      rows = rows.filter((c) => String(c.id).includes(idQ));
    }
    const q = clipNameQ.trim().toLowerCase();
    if (q) {
      rows = rows.filter((c) =>
        (c.clip_name || "").toLowerCase().includes(q),
      );
    }
    if (processedUcFilter === "not_processed") {
      rows = rows.filter((c) => c.processed_use_cases.length === 0);
    } else if (processedUcFilter !== "any") {
      rows = rows.filter((c) =>
        c.processed_use_cases.includes(processedUcFilter),
      );
    }
    return rows;
  }, [list.data, processingFilter, clipIdQ, clipNameQ, processedUcFilter]);

  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const allOnPageSelected =
    items.length > 0 && items.every((c) => selected.has(c.id));

  const toggleSelectAllOnPage = () => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allOnPageSelected) {
        for (const c of items) next.delete(c.id);
      } else {
        for (const c of items) next.add(c.id);
      }
      return next;
    });
  };

  const toggleOne = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      {/* Sticky bg cover for ``.content``'s padding-top:20px zone.
          Without it, scrolling tbody rows briefly show through the
          20px strip between the topbar and the sticky table thead.
          See DailyAttendancePage.tsx for the same pattern + rationale. */}
      <div
        aria-hidden
        style={{
          position: "sticky",
          top: -20,
          zIndex: 25,
          height: 0,
          marginTop: -20,
          paddingTop: 20,
          background: "var(--bg)",
        }}
      />
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("clipAnalytics.title")}</h1>
          <p className="page-sub">
            {list.data
              ? t("clipAnalytics.clipCount", { count: total })
              : "—"}
            {" · "}
            <span className="text-dim">
              {t("clipAnalytics.subtitleLead")}{" "}
              <strong>{t("clipAnalytics.identifyEvent")}</strong>.
            </span>
          </p>
        </div>
        <div className="page-actions">
          {/* Batch "Identify Event" — fires the overall reprocess
              worker across every saved clip with the chosen UCs +
              mode (skip-existing vs reprocess-everything). Reuses
              the same UC tile UI as the per-row modal. */}
          <button
            className="btn btn-primary"
            onClick={() => setBatchOpen(true)}
            disabled={batchRunning}
            title={
              batchRunning
                ? t("clipAnalytics.batch.titleRunning")
                : t("clipAnalytics.batch.titleIdle")
            }
          >
            <Icon name="sparkles" size={12} />
            {batchRunning ? t("clipAnalytics.batch.running") : t("clipAnalytics.identifyEvent")}
          </button>
          {/* Batch Process Status — only renders while a queue
              pipeline batch is in flight. Clicking opens a modal with
              the live queue depth, per-batch progress, and the
              currently-processing clip + use case so operators know
              the worker isn't stuck. */}
          {pipelineBatchRunning && (
            <button
              className="btn"
              onClick={() => setStatusOpen(true)}
              title={t("clipAnalytics.batchStatus.title")}
              aria-label={t("clipAnalytics.batchStatus.aria")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "var(--accent-soft, rgba(99,102,241,0.10))",
                border: "1px solid rgba(99,102,241,0.35)",
                color: "var(--accent-text, #4f46e5)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--accent, #6366f1)",
                  animation: "pipeline-pulse 1.6s infinite",
                }}
              />
              <Icon name="activity" size={12} />
              {t("clipAnalytics.batchStatus.label")}
              {activeBatches.length > 1 && (
                <span
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    background: "var(--accent, #6366f1)",
                    color: "white",
                    borderRadius: 999,
                    padding: "0 6px",
                    marginInlineStart: 2,
                  }}
                >
                  {activeBatches.length}
                </span>
              )}
            </button>
          )}
          {/* Bulk-delete button. Always scoped to the operator's
              ticked rows — never the full filter set. Picking one
              checkbox deletes one clip; picking all visible rows
              deletes only those. The button label adapts so the
              operator can see exactly how many will be deleted before
              they click. */}
          <button
            // Always carry ``btn-danger`` so the matching
            // ``.btn-danger:disabled { opacity: 0.5; cursor:
            // not-allowed }`` rule in styles-enhancements3.css kicks
            // in. With just ``btn`` (the previous behaviour when no
            // rows were ticked) the design CSS has no `:disabled`
            // styling at all — operators saw a functionally-disabled
            // button that visually still looked clickable.
            className="btn btn-danger"
            onClick={() => setBulkDeleteScope("selected")}
            disabled={selected.size === 0 || total === 0}
            aria-disabled={selected.size === 0 || total === 0}
            title={
              selected.size === 0
                ? t("clipAnalytics.bulkDelete.titleNone")
                : t("clipAnalytics.bulkDelete.tickedTitle", { count: selected.size })
            }
            style={
              selected.size === 0 || total === 0
                ? {
                    // Defence in depth on top of the CSS rule — if a
                    // future theme override drops the `.btn-danger:disabled`
                    // styling, these inline values still make the
                    // disabled state visually obvious.
                    opacity: 0.5,
                    cursor: "not-allowed",
                    pointerEvents: "none",
                  }
                : undefined
            }
          >
            <Icon name="trash" size={12} />
            {selected.size === 0
              ? t("clipAnalytics.bulkDelete.labelNone")
              : t("clipAnalytics.bulkDelete.labelN", { count: selected.size })}
          </button>
        </div>
      </div>

      {/* Live batch-progress banner. Pulls from ``useClipPipelineStatus``
          so counters tick in real time as the queue drains. Operator
          can dismiss it via the X — the banner re-shows when a new
          batch starts. Detailed progress (per-UC, currently-processing
          clip) lives in the Batch Process Status modal. */}
      {visibleActiveBatches.length > 0 && (
        <PipelineBatchBanner
          batches={visibleActiveBatches}
          onOpen={() => setStatusOpen(true)}
          onDismiss={() =>
            setDismissedBatchIds(
              new Set(activeBatches.map((b) => b.batch_id)),
            )
          }
        />
      )}

      {/* Processing Health panel — shows aggregate saved/stuck/missing
          counts from the last reconcile sweep and provides one-click
          actions to process unhandled clips or retry failed ones.
          Collapsed by default; expands on click so it doesn't crowd
          the page for users who never touch it. */}
      <ProcessingHealthPanel
        reconcileStatus={reconcileStatus.data ?? null}
        reconcileLoading={reconcileNow.isPending}
        onReconcileNow={() => {
          reconcileNow.mutate();
        }}
        retryLoading={retryFailed.isPending}
        retryDone={retryDone}
        onRetryFailed={() => {
          setRetryDone(null);
          retryFailed.mutate(
            { use_cases: ["uc1", "uc2"], max_clips: 200 },
            {
              onSuccess: (res) => {
                setRetryDone({
                  clips_found: res.clips_found,
                  queued_jobs: res.queued_jobs,
                });
              },
            },
          );
        }}
      />

      <div className="card">
        {/* Filter toolbar — holds filters that don't map to a table
            column (recording mode) plus the global Clear. Keeping them
            here lets the per-column filter row line up 1:1 with the
            column headers below. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
            flexWrap: "wrap",
            padding: "4px 2px 12px",
          }}
        >
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12.5,
              color: "var(--text-secondary)",
            }}
          >
            {t("clipAnalytics.filters.recordingModeLabel")}
            <select
              value={recordingMode}
              onChange={(e) => {
                setRecordingMode(
                  e.target.value as "all" | "save_clips" | "logs_only",
                );
                setPage(1);
              }}
              style={filterControlStyle}
              aria-label={t("clipAnalytics.filters.byRecordingMode")}
            >
              <option value="all">{t("clipAnalytics.recordingMode.all")}</option>
              <option value="save_clips">
                {t("clipAnalytics.recordingMode.saveClips")}
              </option>
              <option value="logs_only">
                {t("clipAnalytics.recordingMode.logsOnly")}
              </option>
            </select>
          </label>
          {hasActiveFilter && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={clearFilters}
              aria-label={t("clipAnalytics.filters.clearAria")}
            >
              <Icon name="x" size={11} /> {t("clipAnalytics.filters.clear")}
            </button>
          )}
        </div>
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
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleSelectAllOnPage}
                  aria-label={t("clipAnalytics.selectAll")}
                />
              </th>
              <th
                style={{
                  width: 120,
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.id")}
              </th>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.camera")}
              </th>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.clipName")}
              </th>
              <th
                style={{
                  width: 160,
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.startTime")}
              </th>
              <th
                style={{
                  width: 160,
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.endTime")}
              </th>
              <th
                style={{
                  width: 90,
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.duration")}
              </th>
              <th
                style={{
                  width: 90,
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.fileSize")}
              </th>
              <th
                style={{
                  width: 140,
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.processingStatus")}
              </th>
              <th
                style={{
                  width: 150,
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.processedUcs")}
              </th>
              {showMatchResult && (
                <th
                  style={{
                    width: 200,
                    background: "var(--bg-elev)",
                    boxShadow: "inset 0 -1px 0 var(--border)",
                  }}
                  title={t("clipAnalytics.cols.matchResultTitle")}
                >
                  {t("clipAnalytics.cols.matchResult")}
                </th>
              )}
              <th
                style={{
                  width: 60,
                  textAlign: "end",
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                {t("clipAnalytics.cols.actions")}
              </th>
            </tr>
            {/* Row 2 — per-column filter inputs */}
            <tr>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              />
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <input
                  type="search"
                  placeholder={t("clipAnalytics.filters.idPlaceholder")}
                  value={clipIdQ}
                  onChange={(e) => setClipIdQ(e.target.value)}
                  style={filterControlStyle}
                  aria-label={t("clipAnalytics.filters.byId")}
                />
              </th>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <select
                  value={cameraId ?? ""}
                  onChange={(e) =>
                    setCameraId(
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  style={filterControlStyle}
                  aria-label={t("clipAnalytics.filters.byCamera")}
                >
                  <option value="">{t("clipAnalytics.filters.allCameras")}</option>
                  {(camerasQuery.data?.items ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </th>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <input
                  type="search"
                  placeholder={t("clipAnalytics.filters.namePlaceholder")}
                  value={clipNameQ}
                  onChange={(e) => setClipNameQ(e.target.value)}
                  style={filterControlStyle}
                  aria-label={t("clipAnalytics.filters.byName")}
                />
              </th>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <DatePicker
                  value={startDate}
                  onChange={(next) => setStartDate(next)}
                  max={todayIso()}
                  ariaLabel={t("clipAnalytics.filters.byStartDate")}
                  placeholder={t("clipAnalytics.filters.byStartDate")}
                  triggerStyle={filterControlStyle}
                />
              </th>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <DatePicker
                  value={endDate}
                  onChange={(next) => setEndDate(next)}
                  {...(startDate ? { min: startDate } : {})}
                  max={todayIso()}
                  ariaLabel={t("clipAnalytics.filters.byEndDate")}
                  placeholder={t("clipAnalytics.filters.byEndDate")}
                  triggerStyle={filterControlStyle}
                />
              </th>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              />
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              />
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <select
                  value={processingFilter}
                  onChange={(e) =>
                    setProcessingFilter(e.target.value as ProcessingFilter)
                  }
                  style={filterControlStyle}
                  aria-label={t("clipAnalytics.filters.byStatus")}
                >
                  <option value="all">{t("clipAnalytics.status.all")}</option>
                  <option value="recording">{t("clipAnalytics.status.recording")}</option>
                  <option value="encoding">{t("clipAnalytics.status.finalizing")}</option>
                  <option value="processing">{t("clipAnalytics.status.processing")}</option>
                  <option value="saved">{t("clipAnalytics.status.saved")}</option>
                  <option value="processed">{t("clipAnalytics.status.processed")}</option>
                </select>
              </th>
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              >
                <select
                  value={processedUcFilter}
                  onChange={(e) =>
                    setProcessedUcFilter(e.target.value as ProcessedUcFilter)
                  }
                  style={filterControlStyle}
                  aria-label={t("clipAnalytics.filters.byProcessedUcs")}
                >
                  <option value="any">{t("clipAnalytics.ucFilter.any")}</option>
                  {enabledUcs.includes("uc1") && <option value="uc1">UC1</option>}
                  {enabledUcs.includes("uc2") && <option value="uc2">UC2</option>}
                  <option value="not_processed">{t("clipAnalytics.ucFilter.notProcessed")}</option>
                </select>
              </th>
              {showMatchResult && (
                <th
                  style={{
                    background: "var(--bg-elev)",
                    boxShadow: "inset 0 -1px 0 var(--border)",
                  }}
                />
              )}
              <th
                style={{
                  background: "var(--bg-elev)",
                  boxShadow: "inset 0 -1px 0 var(--border)",
                }}
              />
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td
                  colSpan={showMatchResult ? 12 : 11}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  {t("clipAnalytics.loading")}
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={showMatchResult ? 12 : 11}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  {t("clipAnalytics.loadError")}
                </td>
              </tr>
            )}
            {!list.isLoading && !list.isError && items.length === 0 && (
              <tr>
                <td
                  colSpan={showMatchResult ? 12 : 11}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  {t("clipAnalytics.empty")}
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
                      checked={isSelected}
                      onChange={() => toggleOne(c.id)}
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
                  <td className="mono text-sm">{c.clip_name || "—"}</td>
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
                    {fmtBytes(c.filesize_bytes)}
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
                  {showMatchResult && (
                    <td className="text-sm">
                      <MatchResultCell clip={c} />
                    </td>
                  )}
                  <td
                    onClick={(e) => e.stopPropagation()}
                    style={{ textAlign: "end" }}
                  >
                    <RowMenu
                      onViewDetails={
                        playable ? () => setDetailTarget(c) : undefined
                      }
                      onEdit={() => alert("Edit coming soon")}
                      onDelete={() => setDeleteTarget(c)}
                      onIdentify={() => setIdentifyTarget(c)}
                      onRetry={
                        c.recording_status === "completed" &&
                        c.processed_use_cases.length < 3 &&
                        (c.processing_use_cases ?? []).length === 0
                          ? () => {
                              setRetryDone(null);
                              retryFailed.mutate(
                                {
                                  use_cases: ALL_USE_CASES.filter(
                                    (uc) =>
                                      !c.processed_use_cases.includes(uc),
                                  ),
                                  max_clips: 1,
                                },
                                {
                                  onSuccess: (res) => {
                                    setRetryDone({
                                      clips_found: res.clips_found,
                                      queued_jobs: res.queued_jobs,
                                    });
                                  },
                                },
                              );
                            }
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
            onPageChange={setPage}
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

      {identifyTarget && (
        <IdentifyEventModal
          clip={identifyTarget}
          onClose={() => setIdentifyTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteClipModal
          clip={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      {bulkDeleteScope !== null && (
        <BulkDeleteClipsModal
          scope={bulkDeleteScope}
          selectedIds={Array.from(selected)}
          filterQs={qs}
          onClose={() => setBulkDeleteScope(null)}
          onDone={() => {
            setSelected(new Set());
            setBulkDeleteScope(null);
            void list.refetch();
          }}
          mutation={bulkDelete}
        />
      )}
      {detailTarget && (
        <ClipDetailDrawer
          clip={detailTarget}
          onClose={() => setDetailTarget(null)}
        />
      )}
      {batchOpen && (
        <BatchIdentifyEventModal onClose={() => setBatchOpen(false)} />
      )}
      {statusOpen && (
        <BatchProcessStatusModal
          batches={activeBatches.concat(
            (pipelineStatus.data?.batches ?? []).filter(
              (b) => b.completed_at !== null,
            ),
          )}
          onClose={() => setStatusOpen(false)}
        />
      )}
      {liveTarget && (
        <LiveProcessingModal
          clip={liveTarget}
          onClose={() => setLiveTarget(null)}
        />
      )}
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
  filterQs,
  onClose,
  onDone,
  mutation,
}: {
  scope: "selected" | "all";
  selectedIds: number[];
  filterQs: string;
  onClose: () => void;
  onDone: () => void;
  mutation: ReturnType<typeof useBulkDeletePersonClips>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [resolvingIds, setResolvingIds] = useState(false);

  const onConfirm = async () => {
    setError(null);
    try {
      let ids: number[] = [];
      if (scope === "selected") {
        ids = selectedIds.slice(0, BULK_DELETE_CAP);
      } else {
        setResolvingIds(true);
        const p = new URLSearchParams(filterQs);
        p.set("page", "1");
        p.set("page_size", String(BULK_DELETE_CAP));
        const res = await api<PersonClipListResponse>(
          `/api/person-clips?${p.toString()}`,
        );
        ids = res.items.map((c) => c.id);
        setResolvingIds(false);
      }
      if (ids.length === 0) {
        setError(t("clipAnalytics.bulkModal.errNone"));
        return;
      }
      await mutation.mutateAsync(ids);
      onDone();
    } catch (e) {
      setResolvingIds(false);
      const message =
        e instanceof Error ? e.message : t("clipAnalytics.bulkModal.errCouldNot");
      setError(message);
    }
  };

  const headline =
    scope === "selected"
      ? t("clipAnalytics.bulkModal.headlineSelected", { count: selectedIds.length })
      : t("clipAnalytics.bulkModal.headlineAll");

  const overCap = scope === "selected" && selectedIds.length > BULK_DELETE_CAP;
  const busy = mutation.isPending || resolvingIds;

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
          aria-label={t("clipAnalytics.bulkModal.aria")}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.18))",
            width: 480,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
            {headline}
          </div>
          <div className="text-sm" style={{ color: "var(--text)" }}>
            {t("clipAnalytics.bulkModal.body")}
          </div>
          {scope === "all" && (
            <div
              style={{
                background: "var(--warning-soft)",
                color: "var(--warning-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              {t("clipAnalytics.bulkModal.capped", { cap: BULK_DELETE_CAP })}
            </div>
          )}
          {overCap && (
            <div
              style={{
                background: "var(--warning-soft)",
                color: "var(--warning-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              {t("clipAnalytics.bulkModal.overCap", { cap: BULK_DELETE_CAP, n: selectedIds.length })}
            </div>
          )}
          {error && (
            <div
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 14,
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
              onClick={() => void onConfirm()}
              disabled={busy}
            >
              {busy ? t("clipAnalytics.deleteModal.deleting") : t("common.delete")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Tiny helpers shared with EmployeesPage in spirit (kept local so this
// page stays self-contained).
// ---------------------------------------------------------------------------

// Tight control style for the per-column header filter row. Width 100%
// so each control fills its <th> column.
const filterControlStyle: React.CSSProperties = {
  padding: "3px 6px",
  fontSize: 11.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
  width: "100%",
  fontWeight: 400,
};

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
// Row action menu — 3-dot kebab with Edit / Delete / Identify Event.
// ---------------------------------------------------------------------------

function RowMenu({
  onViewDetails,
  onEdit,
  onDelete,
  onIdentify,
  onRetry,
}: {
  // ``onViewDetails`` is gated upstream — only ``completed`` clips
  // get the prop. ``recording`` / ``finalizing`` clips render the
  // menu without that entry.
  onViewDetails?: (() => void) | undefined;
  onEdit: () => void;
  onDelete: () => void;
  onIdentify: () => void;
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
          <MenuItem
            label={t("common.edit")}
            iconName="edit"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          />
          <MenuItem
            label={t("clipAnalytics.identifyEvent")}
            iconName="user"
            onClick={() => {
              setOpen(false);
              onIdentify();
            }}
          />
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
  const { t } = useTranslation();
  const del = useDeletePersonClip();
  const [error, setError] = useState<string | null>(null);

  const blockedByLifecycle =
    clip.recording_status === "recording" ||
    clip.recording_status === "finalizing";

  const onConfirm = async () => {
    if (blockedByLifecycle) {
      setError(
        t("clipAnalytics.deleteModal.errBlocked"),
      );
      return;
    }
    setError(null);
    try {
      await del.mutateAsync(clip.id);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : t("clipAnalytics.deleteModal.errCouldNot");
      setError(message);
    }
  };

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
          aria-label="Delete clip"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.18))",
            width: 420,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            {t("clipAnalytics.deleteModal.title")}
          </div>
          <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {clip.camera_name} · {clip.clip_name}
          </div>
          <div
            className="text-sm"
            style={{ marginTop: 10, color: "var(--text)" }}
          >
            {t("clipAnalytics.deleteModal.body")}
          </div>
          {blockedByLifecycle && (
            <div
              style={{
                background: "var(--warning-soft)",
                color: "var(--warning-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              {t("clipAnalytics.deleteModal.blocked", { status: clip.recording_status })}
            </div>
          )}
          {error && (
            <div
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 14,
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={del.isPending}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ background: "var(--danger)", color: "white" }}
              onClick={() => void onConfirm()}
              disabled={del.isPending || blockedByLifecycle}
            >
              {del.isPending ? t("clipAnalytics.deleteModal.deleting") : t("common.delete")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
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

// ---------------------------------------------------------------------------
// Status pill — colour token map for the Processing Status column.
// ---------------------------------------------------------------------------

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
  const status = t(`clipAnalytics.status.${statusKey}`);
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
      case "abandoned":
        return { bg: "var(--danger-soft)", fg: "var(--danger-text)" };
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
