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
  useDetectionConfig,
  usePutDetectionConfig,
  useTrackerConfig,
  usePutTrackerConfig,
} from "./hooks";
import {
  DETECTION_DEFAULTS,
  DET_SIZE_OPTIONS,
  TRACKER_DEFAULTS,
  type DetectionConfig,
  type TrackerConfig,
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

      <DetectionCard />
      <div style={{ height: 16 }} />
      <TrackerCard />
    </>
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
