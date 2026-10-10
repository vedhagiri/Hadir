// P28.5c — System Settings page (Admin only).
//
// Sectioned cards: Clip processing, Detection (mode + det_size +
// thresholds + body-box overlay), Tracker (IoU + idle timeout + max
// event duration), RTSP reconnect, Clip encoding. Save is per-section.
// Validation mirrors the server; ApiError 400 surfaces the offending
// field.
//
// Per-camera ``capture_config.max_event_duration_sec`` (P28.5b) overrides
// this tenant default — the help text under the Tracker section says so.

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { SkeletonPanel } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { Banner, ModalPanel, SectionCard, SettingRow } from "../../features/system/opsUi";
import {
  useClipEncodingConfig,
  useClipPipelineConfig,
  useDetectionConfig,
  usePutClipEncodingConfig,
  usePutDetectionConfig,
  usePutReconnectConfig,
  useReconnectConfig,
  useTrackerConfig,
  usePutTrackerConfig,
  useUpdateClipPipelineConfig,
} from "./hooks";
import {
  CLIP_ENCODING_DEFAULTS,
  CLIP_USE_CASES,
  DETECTION_DEFAULTS,
  DET_SIZE_OPTIONS,
  RECONNECT_DEFAULTS,
  RECONNECT_INTERVAL_MAX_S,
  RECONNECT_INTERVAL_MIN_S,
  RECONNECT_UNIT_SECONDS,
  RESOLUTION_OPTIONS,
  secondsToValueUnit,
  TRACKER_DEFAULTS,
  X264_PRESETS,
  type ClipEncodingConfig,
  type ClipUseCase,
  type DetectionConfig,
  type ReconnectConfig,
  type ReconnectUnit,
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

      <div className="ops-settings-stack">
        <ClipPipelineCard />
        <DetectionCard />
        <TrackerCard />
        <ReconnectCard />
        <ClipEncodingCard />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Clip processing card — UC1/UC2 toggles
//
// Each use case is an independent manual reprocessor that runs against
// saved clips. Turning one OFF stops all processing for it. The PUT body
// is the array of enabled use cases (e.g. ["uc1","uc2"]); all off -> [].

function ClipPipelineCard() {
  const { t } = useTranslation();
  const remote = useClipPipelineConfig();
  const put = useUpdateClipPipelineConfig();
  const [draft, setDraft] = useState<ClipUseCase[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  // Sync draft from server on mount + on every refetch.
  useEffect(() => {
    if (remote.data) setDraft(remote.data.use_cases);
  }, [remote.data]);

  const remoteSet = [...(remote.data?.use_cases ?? [])].sort().join(",");
  const draftSet = [...draft].sort().join(",");
  const dirty = remoteSet !== draftSet;

  const isOn = (uc: ClipUseCase) => draft.includes(uc);

  const toggle = (uc: ClipUseCase, next: boolean) => {
    setDraft((prev) => (next ? [...prev, uc] : prev.filter((x) => x !== uc)));
  };

  const onSave = async () => {
    setToast(null);
    try {
      // Preserve the canonical uc1/uc2 ordering in the PUT body.
      const ordered = CLIP_USE_CASES.filter((uc) => draft.includes(uc));
      await put.mutateAsync({ use_cases: [...ordered] });
      setToast(t("systemSettings.savedToast") as string);
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      setToast(err instanceof ApiError ? formatApiError(err, t) : `✗ ${t("common.errorGeneric")}`);
    }
  };

  if (remote.isLoading) return <SkeletonPanel lines={3} />;

  return (
    <SectionCard
      title={t("systemSettings.clipPipeline.title")}
      sub={t("systemSettings.clipPipeline.subtitle")}
      footer={<CardFooter dirty={dirty} onSave={onSave} saving={put.isPending || remote.isLoading} toast={toast} />}
    >
      {remote.isError && <LoadError onRetry={() => void remote.refetch()} />}

      {CLIP_USE_CASES.map((uc) => (
        <ToggleRow
          key={uc}
          checked={isOn(uc)}
          onChange={(v) => toggle(uc, v)}
          label={t(`systemSettings.clipPipeline.${uc}.label`)}
          hint={t(`systemSettings.clipPipeline.${uc}.hint`)}
        />
      ))}

      <p className="text-xs text-dim" style={{ margin: 0, padding: "12px 0 14px" }}>
        {t("systemSettings.clipPipeline.offHint")}
      </p>
    </SectionCard>
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
  const ids = { detSize: useId(), minFace: useId() };

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
      setToast(err instanceof ApiError ? formatApiError(err, t) : `✗ ${t("common.errorGeneric")}`);
    }
  };

  const onReset = () => {
    setDraft(DETECTION_DEFAULTS);
    setConfirmReset(false);
  };

  if (remote.isLoading) return <SkeletonPanel lines={5} />;

  return (
    <>
      <SectionCard
        title={t("systemSettings.detection.title")}
        sub={t("systemSettings.detection.subtitle")}
        footer={<CardFooter dirty={dirty} onSave={onSave} saving={put.isPending} onReset={() => setConfirmReset(true)} toast={toast} />}
      >
        {remote.isError && <LoadError onRetry={() => void remote.refetch()} />}

        <SettingRow top label={t("systemSettings.detection.mode.label")} help={t(`systemSettings.detection.mode.hint.${draft.mode}`)}>
          <div className="ops-radio-group" role="radiogroup" aria-label={t("systemSettings.detection.mode.label")}>
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
        </SettingRow>

        <SettingRow htmlFor={ids.detSize} label={t("systemSettings.detection.detSize.label")} help={t(`systemSettings.detection.detSize.hint.${draft.det_size}`)}>
          <select
            id={ids.detSize}
            className="select"
            value={String(draft.det_size)}
            onChange={(e) => setDraft({ ...draft, det_size: parseInt(e.target.value, 10) })}
          >
            {DET_SIZE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow label={t("systemSettings.detection.minDetScore.label")} help={t("systemSettings.detection.minDetScore.hint")}>
          <SliderRow
            label={t("systemSettings.detection.minDetScore.label")}
            value={draft.min_det_score}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => setDraft({ ...draft, min_det_score: v })}
            displayDigits={2}
          />
        </SettingRow>

        <SettingRow htmlFor={ids.minFace} label={t("systemSettings.detection.minFaceSize.label")} help={t("systemSettings.detection.minFaceSize.hint")}>
          <input
            id={ids.minFace}
            type="number"
            className="input is-short"
            min={20}
            max={300}
            value={Math.round(Math.sqrt(draft.min_face_pixels))}
            onChange={(e) => {
              const px = clampInt(parseInt(e.target.value, 10), 20, 300);
              setDraft({ ...draft, min_face_pixels: px * px });
            }}
          />
        </SettingRow>

        {draft.mode === "yolo+face" && (
          <>
            <SettingRow label={t("systemSettings.detection.yoloConf.label")} help={t("systemSettings.detection.yoloConf.hint")}>
              <SliderRow
                label={t("systemSettings.detection.yoloConf.label")}
                value={draft.yolo_conf}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setDraft({ ...draft, yolo_conf: v })}
                displayDigits={2}
              />
            </SettingRow>

            <ToggleRow
              checked={draft.show_body_boxes}
              onChange={(v) => setDraft({ ...draft, show_body_boxes: v })}
              label={t("systemSettings.detection.showBodyBoxes.label")}
              hint={t("systemSettings.detection.showBodyBoxes.hint")}
            />
          </>
        )}
      </SectionCard>

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
    </>
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
  const ids = { timeout: useId(), maxDuration: useId() };

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
      setToast(err instanceof ApiError ? formatApiError(err, t) : `✗ ${t("common.errorGeneric")}`);
    }
  };

  const onReset = () => {
    setDraft(TRACKER_DEFAULTS);
    setConfirmReset(false);
  };

  if (remote.isLoading) return <SkeletonPanel lines={3} />;

  return (
    <>
      <SectionCard
        title={t("systemSettings.tracker.title")}
        sub={t("systemSettings.tracker.subtitle")}
        footer={<CardFooter dirty={dirty} onSave={onSave} saving={put.isPending} onReset={() => setConfirmReset(true)} toast={toast} />}
      >
        {remote.isError && <LoadError onRetry={() => void remote.refetch()} />}

        <SettingRow label={t("systemSettings.tracker.iou.label")} help={t("systemSettings.tracker.iou.hint")}>
          <SliderRow
            label={t("systemSettings.tracker.iou.label")}
            value={draft.iou_threshold}
            min={0.05}
            max={0.95}
            step={0.05}
            onChange={(v) => setDraft({ ...draft, iou_threshold: v })}
            displayDigits={2}
          />
        </SettingRow>

        <SettingRow htmlFor={ids.timeout} label={t("systemSettings.tracker.timeout.label")} help={t("systemSettings.tracker.timeout.hint")}>
          <input
            id={ids.timeout}
            type="number"
            className="input is-short"
            min={0.5}
            max={30}
            step={0.5}
            value={draft.timeout_sec}
            onChange={(e) => setDraft({ ...draft, timeout_sec: clampFloat(parseFloat(e.target.value), 0.5, 30) })}
          />
        </SettingRow>

        <SettingRow htmlFor={ids.maxDuration} label={t("systemSettings.tracker.maxDuration.label")} help={t("systemSettings.tracker.maxDuration.hint")}>
          <input
            id={ids.maxDuration}
            type="number"
            className="input is-short"
            min={10}
            max={3600}
            step={1}
            value={draft.max_duration_sec}
            onChange={(e) => setDraft({ ...draft, max_duration_sec: clampFloat(parseFloat(e.target.value), 10, 3600) })}
          />
        </SettingRow>
      </SectionCard>

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
    </>
  );
}

// ---------------------------------------------------------------------------
// RTSP reconnect card (migration 0085)
//
// Enable/disable auto-reconnect + a fixed retry interval the operator
// enters as seconds / minutes / hours. Stored canonically as
// interval_seconds; OFF → the worker makes no reconnect attempts.

function ReconnectCard() {
  const { t } = useTranslation();
  const remote = useReconnectConfig();
  const put = usePutReconnectConfig();
  const [enabled, setEnabled] = useState<boolean>(RECONNECT_DEFAULTS.enabled);
  const [value, setValue] = useState<number>(30);
  const [unit, setUnit] = useState<ReconnectUnit>("seconds");
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const intervalId = useId();

  useEffect(() => {
    if (!remote.data) return;
    setEnabled(remote.data.enabled);
    const vu = secondsToValueUnit(remote.data.interval_seconds);
    setValue(vu.value);
    setUnit(vu.unit);
  }, [remote.data]);

  const unitSeconds = RECONNECT_UNIT_SECONDS[unit];
  const minValue = Math.max(1, Math.ceil(RECONNECT_INTERVAL_MIN_S / unitSeconds));
  const maxValue = Math.floor(RECONNECT_INTERVAL_MAX_S / unitSeconds);
  const intervalSeconds = clampInt(Math.round(value * unitSeconds), RECONNECT_INTERVAL_MIN_S, RECONNECT_INTERVAL_MAX_S);
  const payload: ReconnectConfig = { enabled, interval_seconds: intervalSeconds };
  const dirty = JSON.stringify(payload) !== JSON.stringify(remote.data ?? {});

  const onSave = async () => {
    setToast(null);
    try {
      await put.mutateAsync(payload);
      setToast(t("systemSettings.savedToast") as string);
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      setToast(err instanceof ApiError ? formatApiError(err, t) : `✗ ${t("common.errorGeneric")}`);
    }
  };

  const onReset = () => {
    setEnabled(RECONNECT_DEFAULTS.enabled);
    const vu = secondsToValueUnit(RECONNECT_DEFAULTS.interval_seconds);
    setValue(vu.value);
    setUnit(vu.unit);
    setConfirmReset(false);
  };

  if (remote.isLoading) return <SkeletonPanel lines={2} />;

  return (
    <>
      <SectionCard
        title={t("systemSettings.reconnect.title")}
        sub={t("systemSettings.reconnect.subtitle")}
        footer={<CardFooter dirty={dirty} onSave={onSave} saving={put.isPending} onReset={() => setConfirmReset(true)} toast={toast} />}
      >
        {remote.isError && <LoadError onRetry={() => void remote.refetch()} />}

        <ToggleRow
          checked={enabled}
          onChange={setEnabled}
          label={t("systemSettings.reconnect.enabled.label")}
          hint={t("systemSettings.reconnect.enabled.hint")}
        />

        {enabled && (
          <SettingRow htmlFor={intervalId} label={t("systemSettings.reconnect.interval.label")} help={t("systemSettings.reconnect.interval.hint")}>
            <div className="ops-inline">
              <input
                id={intervalId}
                type="number"
                className="input is-short"
                min={minValue}
                max={maxValue}
                step={1}
                value={value}
                onChange={(e) => setValue(clampInt(parseInt(e.target.value, 10), minValue, maxValue))}
              />
              <select
                className="select"
                style={{ width: 140 }}
                value={unit}
                onChange={(e) => setUnit(e.target.value as ReconnectUnit)}
                aria-label={t("systemSettings.reconnect.unitLabel", { defaultValue: "Unit" })}
              >
                <option value="seconds">{t("systemSettings.reconnect.unit.seconds")}</option>
                <option value="minutes">{t("systemSettings.reconnect.unit.minutes")}</option>
                <option value="hours">{t("systemSettings.reconnect.unit.hours")}</option>
              </select>
            </div>
            <span className="field-help">{t("systemSettings.reconnect.effective", { seconds: intervalSeconds })}</span>
          </SettingRow>
        )}
      </SectionCard>

      {confirmReset && (
        <ConfirmModal
          title={t("systemSettings.resetConfirm.title")}
          message={t("systemSettings.reconnect.resetConfirm")}
          onConfirm={onReset}
          onCancel={() => setConfirmReset(false)}
          confirmLabel={t("common.reset")}
          cancelLabel={t("common.cancel")}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Clip encoding card (Phase C — migration 0052)

function ClipEncodingCard() {
  const { t } = useTranslation();
  const remote = useClipEncodingConfig();
  const put = usePutClipEncodingConfig();
  const [draft, setDraft] = useState<ClipEncodingConfig>(CLIP_ENCODING_DEFAULTS);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const ids = { preset: useId(), resolution: useId() };

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
      setToast(err instanceof ApiError ? formatApiError(err, t) : `✗ ${t("common.errorGeneric")}`);
    }
  };

  const onReset = () => {
    setDraft(CLIP_ENCODING_DEFAULTS);
    setConfirmReset(false);
  };

  if (remote.isLoading) return <SkeletonPanel lines={5} />;

  return (
    <>
      <SectionCard
        title={t("systemSettings.clipEncoding.title")}
        sub={t("systemSettings.clipEncoding.subtitle")}
        footer={<CardFooter dirty={dirty} onSave={onSave} saving={put.isPending} onReset={() => setConfirmReset(true)} toast={toast} />}
      >
        {remote.isError && <LoadError onRetry={() => void remote.refetch()} />}

        <SettingRow label={t("systemSettings.clipEncoding.chunkDuration.label")} help={t("systemSettings.clipEncoding.chunkDuration.hint")}>
          <SliderRow
            label={t("systemSettings.clipEncoding.chunkDuration.label")}
            value={draft.chunk_duration_sec}
            min={60}
            max={600}
            step={10}
            displayDigits={0}
            onChange={(v) => setDraft({ ...draft, chunk_duration_sec: clampInt(v, 60, 600) })}
          />
        </SettingRow>

        <SettingRow label={t("systemSettings.clipEncoding.crf.label")} help={t("systemSettings.clipEncoding.crf.hint")}>
          <SliderRow
            label={t("systemSettings.clipEncoding.crf.label")}
            value={draft.video_crf}
            min={18}
            max={30}
            step={1}
            displayDigits={0}
            onChange={(v) => setDraft({ ...draft, video_crf: clampInt(v, 18, 30) })}
          />
        </SettingRow>

        <SettingRow htmlFor={ids.preset} label={t("systemSettings.clipEncoding.preset.label")} help={t("systemSettings.clipEncoding.preset.hint")}>
          <select
            id={ids.preset}
            className="select"
            value={draft.video_preset}
            onChange={(e) => setDraft({ ...draft, video_preset: e.target.value as X264Preset })}
          >
            {X264_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow htmlFor={ids.resolution} label={t("systemSettings.clipEncoding.resolution.label")} help={t("systemSettings.clipEncoding.resolution.hint")}>
          <select
            id={ids.resolution}
            className="select"
            value={draft.resolution_max_height == null ? "native" : String(draft.resolution_max_height)}
            onChange={(e) =>
              setDraft({
                ...draft,
                resolution_max_height: e.target.value === "native" ? null : parseInt(e.target.value, 10),
              })
            }
          >
            <option value="native">{t("systemSettings.clipEncoding.resolution.native")}</option>
            {RESOLUTION_OPTIONS.filter((h) => h != null).map((h) => (
              <option key={String(h)} value={String(h)}>
                {h}p
              </option>
            ))}
          </select>
        </SettingRow>

        <ToggleRow
          checked={draft.keep_chunks_after_merge}
          onChange={(v) => setDraft({ ...draft, keep_chunks_after_merge: v })}
          label={t("systemSettings.clipEncoding.keepChunks.label")}
          hint={t("systemSettings.clipEncoding.keepChunks.hint")}
        />
      </SectionCard>

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
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers

function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: "14px 0 0" }}>
      <Banner tone="danger" icon={<Icon name="info" size={14} />} role="alert">
        <span>{t("systemSettings.loadFailed", { defaultValue: "Couldn't load this section's current values." })}</span>
        <span className="ops-banner-spacer" />
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <Icon name="refresh" size={11} />
          {t("common.retry", { defaultValue: "Retry" })}
        </button>
      </Banner>
    </div>
  );
}

interface CardFooterProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset?: () => void;
  toast: string | null;
}

function CardFooter({ dirty, saving, onSave, onReset, toast }: CardFooterProps) {
  const { t } = useTranslation();
  return (
    <div className="ops-card-foot">
      <div style={{ flex: 1, minWidth: 0 }}>
        {toast && (
          <span className={`ops-feedback ${toast.startsWith("✗") ? "is-err" : "is-ok"}`} role="status">
            {toast}
          </span>
        )}
      </div>
      <div className="ops-card-foot-actions">
        {onReset && (
          <button type="button" className="btn" onClick={onReset} disabled={saving}>
            {t("systemSettings.resetButton")}
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={!dirty || saving}>
          <Icon name="check" size={12} />
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}

function RadioOption({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className={`ops-radio${checked ? " is-checked" : ""}`}>
      <input type="radio" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const id = useId();
  return (
    <div className="ops-setting-row">
      <div>
        <label htmlFor={id} className="ops-setting-label">{label}</label>
        {hint && <span className="ops-setting-hint">{hint}</span>}
      </div>
      <div className="ops-setting-control">
        <label className="ops-switch-wrap" htmlFor={id}>
          <span aria-hidden className={`ops-switch${checked ? " is-on" : ""}${focused ? " is-focus" : ""}`}>
            <span className="ops-switch-knob" />
          </span>
          <input
            id={id}
            type="checkbox"
            role="switch"
            aria-checked={checked}
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="ops-switch-input"
          />
          <span className={`ops-switch-state${checked ? " is-on" : ""}`}>
            {checked ? t("systemSettings.switchOn", { defaultValue: "On" }) : t("systemSettings.switchOff", { defaultValue: "Off" })}
          </span>
        </label>
      </div>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  displayDigits = 2,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  displayDigits?: number;
}) {
  return (
    <div className="ops-slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} aria-label={label} />
      <span className="ops-slider-value" aria-hidden>
        {value.toFixed(displayDigits)}
      </span>
    </div>
  );
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
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
      <ModalPanel
        title={title}
        ariaLabel={title}
        footer={
          <>
            <button type="button" className="btn" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button type="button" className="btn btn-primary" onClick={onConfirm}>
              {confirmLabel}
            </button>
          </>
        }
      >
        <p className="text-sm" style={{ margin: 0, color: "var(--text-secondary)" }}>{message}</p>
      </ModalPanel>
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
