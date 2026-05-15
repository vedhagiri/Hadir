// P28.5c — System Settings page (Admin only).
//
// Two cards: Detection (mode + det_size + thresholds + body-box overlay)
// and Tracker (IoU + idle timeout + max event duration). Save is per-
// section. Validation mirrors the server; ApiError 400 surfaces the
// offending field.
//
// Per-camera ``capture_config.max_event_duration_sec`` (P28.5b) overrides
// this tenant default — the help text under the Tracker section says so.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import {
  useClipEncodingConfig,
  useDetectionConfig,
  useLiveMatchingConfig,
  usePutClipEncodingConfig,
  usePutDetectionConfig,
  usePutLiveMatchingConfig,
  useTrackerConfig,
  usePutTrackerConfig,
} from "./hooks";
import {
  CLIP_ENCODING_DEFAULTS,
  DETECTION_DEFAULTS,
  DET_SIZE_OPTIONS,
  RESOLUTION_OPTIONS,
  TRACKER_DEFAULTS,
  X264_PRESETS,
  type ClipEncodingConfig,
  type DetectionConfig,
  type TrackerConfig,
  type X264Preset,
} from "./types";

export function SystemSettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("systemSettings.title")}</h1>
          <p className="page-sub">{t("systemSettings.subtitle")}</p>
        </div>
      </div>

      <LiveMatchingCard />
      <div style={{ height: 16 }} />
      <DetectionCard />
      <div style={{ height: 16 }} />
      <TrackerCard />
      <div style={{ height: 16 }} />
      <ClipEncodingCard />
    </>
  );
}


// ---------------------------------------------------------------------------
// Live identification card (migration 0059)
//
// Master switch for the live face-matching pipeline. When OFF, the
// analyzer thread skips face detection / recognition / embedding /
// matcher_cache / detection_events emission. Person bounding boxes
// still drive the live preview overlay and the clip-recording trigger;
// identification only happens later via the manual UC1/UC2/UC3
// reprocessors on saved clips.

function LiveMatchingCard() {
  const { t } = useTranslation();
  const remote = useLiveMatchingConfig();
  const put = usePutLiveMatchingConfig();
  const enabled = remote.data?.enabled ?? true;
  const [toast, setToast] = useState<string | null>(null);

  const onToggle = async (next: boolean) => {
    setToast(null);
    try {
      await put.mutateAsync({ enabled: next });
      setToast(
        next
          ? (t("systemSettings.liveMatching.toastOn") as string)
          : (t("systemSettings.liveMatching.toastOff") as string),
      );
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      if (err instanceof ApiError) {
        setToast(formatApiError(err, t));
      } else {
        setToast(t("common.errorGeneric") as string);
      }
    }
  };

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="card-title" style={{ marginBottom: 4 }}>
            {t("systemSettings.liveMatching.title")}
          </h2>
          <p
            className="card-sub"
            style={{ margin: 0, color: "var(--text-secondary)" }}
          >
            {t("systemSettings.liveMatching.subtitle")}
          </p>
          <ul
            style={{
              marginTop: 12,
              marginBottom: 0,
              paddingInlineStart: 18,
              color: "var(--text-secondary)",
              fontSize: 12.5,
              lineHeight: 1.7,
            }}
          >
            <li>{t("systemSettings.liveMatching.bullet1")}</li>
            <li>{t("systemSettings.liveMatching.bullet2")}</li>
            <li>{t("systemSettings.liveMatching.bullet3")}</li>
            <li>{t("systemSettings.liveMatching.bullet4")}</li>
          </ul>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 8,
            minWidth: 200,
          }}
        >
          <span
            style={{
              fontSize: 11,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: enabled ? "var(--success-text)" : "var(--warning-text)",
              fontWeight: 700,
            }}
          >
            {enabled
              ? t("systemSettings.liveMatching.statusOn")
              : t("systemSettings.liveMatching.statusOff")}
          </span>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              cursor: put.isPending ? "wait" : "pointer",
            }}
          >
            <span style={{ fontSize: 13, color: "var(--text)" }}>
              {t("systemSettings.liveMatching.toggleLabel")}
            </span>
            <span
              aria-hidden
              style={{
                position: "relative",
                width: 42,
                height: 24,
                borderRadius: 999,
                background: enabled
                  ? "var(--success-text)"
                  : "var(--border)",
                transition: "background 160ms ease",
                opacity: put.isPending ? 0.6 : 1,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  insetInlineStart: enabled ? 20 : 2,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
                  transition: "inset-inline-start 160ms ease",
                }}
              />
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => void onToggle(e.target.checked)}
              disabled={put.isPending}
              aria-label={
                t("systemSettings.liveMatching.toggleLabel") as string
              }
              style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
            />
          </label>
          {toast && (
            <span
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                textAlign: "end",
                maxWidth: 220,
              }}
            >
              {toast}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detection card

function DetectionCard() {
  const { t } = useTranslation();
  const remote = useDetectionConfig();
  const put = usePutDetectionConfig();
  const [draft, setDraft] = useState<DetectionConfig>(DETECTION_DEFAULTS);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Sync draft from server on mount + on every refetch.
  useEffect(() => {
    if (remote.data) setDraft(remote.data);
  }, [remote.data]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(remote.data ?? {});

  const onSave = async () => {
    setToast(null);
    try {
      await put.mutateAsync(draft);
      setToast(t("systemSettings.savedToast") as string);
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      if (err instanceof ApiError) {
        setToast(formatApiError(err, t));
      } else {
        setToast(t("common.errorGeneric") as string);
      }
    }
  };

  const onReset = () => {
    setDraft(DETECTION_DEFAULTS);
    setConfirmReset(false);
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{t("systemSettings.detection.title")}</h3>
        <p className="card-sub">{t("systemSettings.detection.subtitle")}</p>
      </div>
      <div
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <FieldGroup
          label={t("systemSettings.detection.mode.label")}
          hint={t(`systemSettings.detection.mode.hint.${draft.mode}`)}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <RadioOption
              checked={draft.mode === "insightface"}
              onChange={() => setDraft({ ...draft, mode: "insightface" })}
              label={t("systemSettings.detection.mode.insightfaceLabel")}
            />
            <RadioOption
              checked={draft.mode === "yolo+face"}
              onChange={() => setDraft({ ...draft, mode: "yolo+face" })}
              label={t("systemSettings.detection.mode.yoloLabel")}
            />
          </div>
        </FieldGroup>

        <FieldGroup
          label={t("systemSettings.detection.detSize.label")}
          hint={t(`systemSettings.detection.detSize.hint.${draft.det_size}`)}
        >
          <select
            value={String(draft.det_size)}
            onChange={(e) =>
              setDraft({ ...draft, det_size: parseInt(e.target.value, 10) })
            }
            style={inputStyle}
          >
            {DET_SIZE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </FieldGroup>

        <FieldGroup
          label={t("systemSettings.detection.minDetScore.label")}
          hint={t("systemSettings.detection.minDetScore.hint")}
        >
          <SliderRow
            value={draft.min_det_score}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => setDraft({ ...draft, min_det_score: v })}
            displayDigits={2}
          />
        </FieldGroup>

        <FieldGroup
          label={t("systemSettings.detection.minFaceSize.label")}
          hint={t("systemSettings.detection.minFaceSize.hint")}
        >
          <input
            type="number"
            min={20}
            max={300}
            value={Math.round(Math.sqrt(draft.min_face_pixels))}
            onChange={(e) => {
              const px = clampInt(parseInt(e.target.value, 10), 20, 300);
              setDraft({ ...draft, min_face_pixels: px * px });
            }}
            style={inputStyle}
          />
        </FieldGroup>

        {draft.mode === "yolo+face" && (
          <>
            <FieldGroup
              label={t("systemSettings.detection.yoloConf.label")}
              hint={t("systemSettings.detection.yoloConf.hint")}
            >
              <SliderRow
                value={draft.yolo_conf}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setDraft({ ...draft, yolo_conf: v })}
                displayDigits={2}
              />
            </FieldGroup>

            <ToggleRow
              checked={draft.show_body_boxes}
              onChange={(v) => setDraft({ ...draft, show_body_boxes: v })}
              label={t("systemSettings.detection.showBodyBoxes.label")}
              hint={t("systemSettings.detection.showBodyBoxes.hint")}
            />
          </>
        )}

        <CardFooter
          dirty={dirty}
          onSave={onSave}
          saving={put.isPending}
          onReset={() => setConfirmReset(true)}
          toast={toast}
        />
      </div>

      {confirmReset && (
        <ConfirmModal
          title={t("systemSettings.resetConfirm.title")}
          message={t("systemSettings.detection.resetConfirm")}
          onConfirm={onReset}
          onCancel={() => setConfirmReset(false)}
          confirmLabel={t("common.reset")}
          cancelLabel={t("common.cancel")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tracker card

function TrackerCard() {
  const { t } = useTranslation();
  const remote = useTrackerConfig();
  const put = usePutTrackerConfig();
  const [draft, setDraft] = useState<TrackerConfig>(TRACKER_DEFAULTS);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (remote.data) setDraft(remote.data);
  }, [remote.data]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(remote.data ?? {});

  const onSave = async () => {
    setToast(null);
    try {
      await put.mutateAsync(draft);
      setToast(t("systemSettings.savedToast") as string);
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      if (err instanceof ApiError) {
        setToast(formatApiError(err, t));
      } else {
        setToast(t("common.errorGeneric") as string);
      }
    }
  };

  const onReset = () => {
    setDraft(TRACKER_DEFAULTS);
    setConfirmReset(false);
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{t("systemSettings.tracker.title")}</h3>
        <p className="card-sub">{t("systemSettings.tracker.subtitle")}</p>
      </div>
      <div
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <FieldGroup
          label={t("systemSettings.tracker.iou.label")}
          hint={t("systemSettings.tracker.iou.hint")}
        >
          <SliderRow
            value={draft.iou_threshold}
            min={0.05}
            max={0.95}
            step={0.05}
            onChange={(v) => setDraft({ ...draft, iou_threshold: v })}
            displayDigits={2}
          />
        </FieldGroup>

        <FieldGroup
          label={t("systemSettings.tracker.timeout.label")}
          hint={t("systemSettings.tracker.timeout.hint")}
        >
          <input
            type="number"
            min={0.5}
            max={30}
            step={0.5}
            value={draft.timeout_sec}
            onChange={(e) =>
              setDraft({
                ...draft,
                timeout_sec: clampFloat(parseFloat(e.target.value), 0.5, 30),
              })
            }
            style={inputStyle}
          />
        </FieldGroup>

        <FieldGroup
          label={t("systemSettings.tracker.maxDuration.label")}
          hint={t("systemSettings.tracker.maxDuration.hint")}
        >
          <input
            type="number"
            min={10}
            max={3600}
            step={1}
            value={draft.max_duration_sec}
            onChange={(e) =>
              setDraft({
                ...draft,
                max_duration_sec: clampFloat(
                  parseFloat(e.target.value), 10, 3600,
                ),
              })
            }
            style={inputStyle}
          />
        </FieldGroup>

        <CardFooter
          dirty={dirty}
          onSave={onSave}
          saving={put.isPending}
          onReset={() => setConfirmReset(true)}
          toast={toast}
        />
      </div>

      {confirmReset && (
        <ConfirmModal
          title={t("systemSettings.resetConfirm.title")}
          message={t("systemSettings.tracker.resetConfirm")}
          onConfirm={onReset}
          onCancel={() => setConfirmReset(false)}
          confirmLabel={t("common.reset")}
          cancelLabel={t("common.cancel")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clip encoding card (Phase C — migration 0052)

function ClipEncodingCard() {
  const { t } = useTranslation();
  const remote = useClipEncodingConfig();
  const put = usePutClipEncodingConfig();
  const [draft, setDraft] = useState<ClipEncodingConfig>(
    CLIP_ENCODING_DEFAULTS,
  );
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (remote.data) setDraft(remote.data);
  }, [remote.data]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(remote.data ?? {});

  const onSave = async () => {
    setToast(null);
    try {
      await put.mutateAsync(draft);
      setToast(t("systemSettings.savedToast") as string);
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      if (err instanceof ApiError) {
        setToast(formatApiError(err, t));
      } else {
        setToast(t("common.errorGeneric") as string);
      }
    }
  };

  const onReset = () => {
    setDraft(CLIP_ENCODING_DEFAULTS);
    setConfirmReset(false);
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">
          {t("systemSettings.clipEncoding.title")}
        </h3>
        <p className="card-sub">
          {t("systemSettings.clipEncoding.subtitle")}
        </p>
      </div>
      <div
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <FieldGroup
          label={t("systemSettings.clipEncoding.chunkDuration.label")}
          hint={t("systemSettings.clipEncoding.chunkDuration.hint")}
        >
          <SliderRow
            value={draft.chunk_duration_sec}
            min={60}
            max={600}
            step={10}
            displayDigits={0}
            onChange={(v) =>
              setDraft({
                ...draft,
                chunk_duration_sec: clampInt(v, 60, 600),
              })
            }
          />
        </FieldGroup>

        <FieldGroup
          label={t("systemSettings.clipEncoding.crf.label")}
          hint={t("systemSettings.clipEncoding.crf.hint")}
        >
          <SliderRow
            value={draft.video_crf}
            min={18}
            max={30}
            step={1}
            displayDigits={0}
            onChange={(v) =>
              setDraft({
                ...draft,
                video_crf: clampInt(v, 18, 30),
              })
            }
          />
        </FieldGroup>

        <FieldGroup
          label={t("systemSettings.clipEncoding.preset.label")}
          hint={t("systemSettings.clipEncoding.preset.hint")}
        >
          <select
            value={draft.video_preset}
            onChange={(e) =>
              setDraft({
                ...draft,
                video_preset: e.target.value as X264Preset,
              })
            }
            style={inputStyle}
          >
            {X264_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </FieldGroup>

        <FieldGroup
          label={t("systemSettings.clipEncoding.resolution.label")}
          hint={t("systemSettings.clipEncoding.resolution.hint")}
        >
          <select
            value={
              draft.resolution_max_height == null
                ? "native"
                : String(draft.resolution_max_height)
            }
            onChange={(e) =>
              setDraft({
                ...draft,
                resolution_max_height:
                  e.target.value === "native"
                    ? null
                    : parseInt(e.target.value, 10),
              })
            }
            style={inputStyle}
          >
            <option value="native">
              {t("systemSettings.clipEncoding.resolution.native")}
            </option>
            {RESOLUTION_OPTIONS.filter((h) => h != null).map((h) => (
              <option key={String(h)} value={String(h)}>
                {h}p
              </option>
            ))}
          </select>
        </FieldGroup>

        <ToggleRow
          checked={draft.keep_chunks_after_merge}
          onChange={(v) =>
            setDraft({ ...draft, keep_chunks_after_merge: v })
          }
          label={t("systemSettings.clipEncoding.keepChunks.label")}
          hint={t("systemSettings.clipEncoding.keepChunks.hint")}
        />

        <CardFooter
          dirty={dirty}
          onSave={onSave}
          saving={put.isPending}
          onReset={() => setConfirmReset(true)}
          toast={toast}
        />
      </div>

      {confirmReset && (
        <ConfirmModal
          title={t("systemSettings.resetConfirm.title")}
          message={t("systemSettings.clipEncoding.resetConfirm")}
          onConfirm={onReset}
          onCancel={() => setConfirmReset(false)}
          confirmLabel={t("common.reset")}
          cancelLabel={t("common.cancel")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers

interface CardFooterProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  toast: string | null;
}

function CardFooter({
  dirty, saving, onSave, onReset, toast,
}: CardFooterProps) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 8,
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {toast && (
          <span
            className="text-sm"
            style={{
              color: toast.startsWith("✗")
                ? "var(--danger-text)"
                : "var(--success-text)",
            }}
          >
            {toast}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={onReset} disabled={saving}>
          {t("systemSettings.resetButton")}
        </button>
        <button
          className="btn btn-primary"
          onClick={onSave}
          disabled={!dirty || saving}
        >
          <Icon name="check" size={12} />
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}

function FieldGroup({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
      {children}
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </label>
  );
}

function RadioOption({
  checked, onChange, label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        fontSize: 13,
      }}
    >
      <input type="radio" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

function ToggleRow({
  checked, onChange, label, hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        cursor: "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </span>
      {hint && (
        <span
          className="text-xs text-dim"
          style={{ marginInlineStart: 22 }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

function SliderRow({
  value, min, max, step, onChange, displayDigits = 2,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  displayDigits?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1 }}
      />
      <span className="mono text-sm" style={{ width: 50, textAlign: "end" }}>
        {value.toFixed(displayDigits)}
      </span>
    </div>
  );
}

function ConfirmModal({
  title, message, confirmLabel, cancelLabel, onConfirm, onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalShell onClose={onCancel}>
      <div
        role="dialog"
        aria-label={title}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          padding: 20,
          minWidth: 320,
          zIndex: 1000,
          boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
          {title}
        </div>
        <div className="text-sm text-secondary" style={{ marginBottom: 16 }}>
          {message}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Helpers

function clampInt(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function clampFloat(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

interface ApiErrorBody {
  detail?: { field?: string; message?: string };
}

function formatApiError(err: ApiError, t: (k: string) => string): string {
  if (err.status === 400 && err.body && typeof err.body === "object") {
    const detail = (err.body as ApiErrorBody).detail;
    if (detail?.field && detail?.message) {
      return `✗ ${detail.field}: ${detail.message}`;
    }
  }
  return `✗ ${t("common.errorGeneric")}`;
}

const inputStyle = {
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;
