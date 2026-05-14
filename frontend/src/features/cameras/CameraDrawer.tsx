// Add/Edit form drawer for a camera. The RTSP URL field is write-only
// in the UI — on edit we display ``***`` as a placeholder and only send
// ``rtsp_url`` if the user actually types something new. That preserves
// the backend rule that the stored cipher is left untouched when the
// field is omitted from PATCH.
//
// P28.5b: ``enabled`` was split into two independent toggles
// (``worker_enabled`` + ``display_enabled``) and the per-camera
// ``capture_config`` knob bag was added. Settings panel is collapsed
// by default (most operators won't need to tune it).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DrawerShell } from "../../components/DrawerShell";

import { Icon } from "../../shell/Icon";
import { BrandLogo } from "./BrandLogo";
import { useCreateCamera, usePatchCamera } from "./hooks";
import {
  BRAND_OPTIONS,
  CLIP_DETECTION_SOURCES,
  DEFAULT_CAPTURE_CONFIG,
  ZONE_OPTIONS,
  type Camera,
  type CameraCreateInput,
  type CameraPatchInput,
  type CaptureConfig,
  type ClipDetectionSource,
} from "./types";

interface Props {
  mode: "create" | "edit";
  initial: Camera | null;
  onClose: () => void;
}

function configsEqual(a: CaptureConfig, b: CaptureConfig): boolean {
  return (
    a.max_faces_per_event === b.max_faces_per_event &&
    a.max_event_duration_sec === b.max_event_duration_sec &&
    a.min_face_quality_to_save === b.min_face_quality_to_save &&
    a.save_full_frames === b.save_full_frames
  );
}

export function CameraDrawer({ mode, initial, onClose }: Props) {
  const { t } = useTranslation();
  const create = useCreateCamera();
  const patch = usePatchCamera();

  const [name, setName] = useState(initial?.name ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [zone, setZone] = useState(initial?.zone ?? "");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  // New cameras default every pipeline switch to OFF. Operator
  // explicitly turns on what they want after adding the row. Edit
  // mode honours whatever the persisted row already carries.
  const [workerEnabled, setWorkerEnabled] = useState(
    initial?.worker_enabled ?? false,
  );
  const [displayEnabled, setDisplayEnabled] = useState(
    initial?.display_enabled ?? false,
  );
  const [detectionEnabled, setDetectionEnabled] = useState(
    initial?.detection_enabled ?? false,
  );
  const [clipRecordingEnabled, setClipRecordingEnabled] = useState(
    initial?.clip_recording_enabled ?? false,
  );
  // Migration 0053: default for new cameras is 'body' so seated /
  // back-to-camera employees still keep clips recording (YOLO finds
  // a still body just fine). Existing cameras keep whatever value
  // was persisted on the row.
  const [clipDetectionSource, setClipDetectionSource] =
    useState<ClipDetectionSource>(
      initial?.clip_detection_source ?? "body",
    );
  const [config, setConfig] = useState<CaptureConfig>(
    initial?.capture_config ?? DEFAULT_CAPTURE_CONFIG,
  );
  const [rtspUrl, setRtspUrl] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(initial?.name ?? "");
    setLocation(initial?.location ?? "");
    setZone(initial?.zone ?? "");
    setBrand(initial?.brand ?? "");
    setWorkerEnabled(initial?.worker_enabled ?? false);
    setDisplayEnabled(initial?.display_enabled ?? false);
    setDetectionEnabled(initial?.detection_enabled ?? false);
    setClipRecordingEnabled(initial?.clip_recording_enabled ?? false);
    setClipDetectionSource(initial?.clip_detection_source ?? "body");
    setConfig(initial?.capture_config ?? DEFAULT_CAPTURE_CONFIG);
    setRtspUrl("");
    setShowSettings(false);
    setError(null);
  }, [initial]);

  const submitting = create.isPending || patch.isPending;

  const submit = async () => {
    setError(null);
    try {
      if (mode === "create") {
        if (!rtspUrl.trim()) {
          setError(t("cameras.errors.rtspRequired"));
          return;
        }
        // "Others" is a UI-only sentinel for "no specific brand" —
        // store as null so the BrandLogo falls back to the generic
        // camera icon.
        const brandNorm =
          brand && brand !== "Others" ? brand : null;
        const input: CameraCreateInput = {
          name: name.trim(),
          location: location.trim(),
          zone: zone || null,
          rtsp_url: rtspUrl.trim(),
          worker_enabled: workerEnabled,
          display_enabled: displayEnabled,
          detection_enabled: detectionEnabled,
          clip_recording_enabled: clipRecordingEnabled,
          clip_detection_source: clipDetectionSource,
          capture_config: config,
          brand: brandNorm,
        };
        await create.mutateAsync(input);
      } else {
        if (!initial) return;
        const patchBody: CameraPatchInput = {};
        if (name.trim() !== initial.name) patchBody.name = name.trim();
        if (location.trim() !== initial.location) patchBody.location = location.trim();
        const zoneNorm = zone || null;
        if (zoneNorm !== (initial.zone ?? null)) patchBody.zone = zoneNorm;
        const brandNorm = brand && brand !== "Others" ? brand : null;
        if (brandNorm !== (initial.brand ?? null)) patchBody.brand = brandNorm;
        if (workerEnabled !== initial.worker_enabled) {
          patchBody.worker_enabled = workerEnabled;
        }
        if (displayEnabled !== initial.display_enabled) {
          patchBody.display_enabled = displayEnabled;
        }
        if (detectionEnabled !== initial.detection_enabled) {
          patchBody.detection_enabled = detectionEnabled;
        }
        if (clipRecordingEnabled !== initial.clip_recording_enabled) {
          patchBody.clip_recording_enabled = clipRecordingEnabled;
        }
        if (
          clipDetectionSource !==
          (initial.clip_detection_source ?? "face")
        ) {
          patchBody.clip_detection_source = clipDetectionSource;
        }
        if (!configsEqual(config, initial.capture_config)) {
          patchBody.capture_config = config;
        }
        if (rtspUrl.trim()) patchBody.rtsp_url = rtspUrl.trim();
        if (Object.keys(patchBody).length === 0) {
          onClose();
          return;
        }
        await patch.mutateAsync({ id: initial.id, patch: patchBody });
      }
      onClose();
    } catch {
      setError(t("cameras.errors.saveFailed"));
    }
  };

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">{t("cameras.label")}</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {mode === "create"
                ? t("cameras.addTitle")
                : `${t("cameras.editTitle")} · ${initial?.name ?? ""}`}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div
          className="drawer-body"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          {/* Running camera code — surfaced as a read-only mono badge
              on edit (auto-assigned on create, immutable in this UI;
              operators with the SQL key can rename via PATCH later
              if needed). */}
          {mode === "edit" && initial?.camera_code && (
            <Field label={t("cameras.fields.cameraCode")}>
              <div
                className="mono"
                style={{
                  ...inputStyle,
                  background: "var(--bg-sunken)",
                  color: "var(--text-secondary)",
                  fontWeight: 600,
                }}
              >
                {initial.camera_code}
              </div>
            </Field>
          )}

          <Field label={t("cameras.fields.name")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("cameras.placeholders.name")}
              style={inputStyle}
              autoFocus
              maxLength={120}
            />
          </Field>

          <Field label={t("cameras.fields.location")}>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("cameras.placeholders.location")}
              style={inputStyle}
              maxLength={200}
            />
          </Field>

          <Field
            label={t("cameras.fields.zone")}
            hint={t("cameras.hints.zone")}
          >
            <select
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              style={inputStyle}
            >
              <option value="">{t("cameras.fields.zoneNone") as string}</option>
              {ZONE_OPTIONS.map((z) => (
                <option key={z} value={z}>
                  {t(`cameras.zone.${z}`, { defaultValue: z }) as string}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Brand"
            hint="Used to render a brand-coloured chip next to this camera in lists. Pick Others if your brand isn't listed — a generic camera icon is shown."
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <BrandLogo
                brand={brand && brand !== "Others" ? brand : null}
                size={28}
              />
              <select
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
              >
                <option value="">— Pick a brand —</option>
                {BRAND_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </Field>

          <Field
            label={t("cameras.fields.rtspUrl")}
            hint={
              mode === "edit"
                ? t("cameras.hints.rtspEdit")
                : t("cameras.hints.rtspCreate")
            }
          >
            <input
              value={rtspUrl}
              onChange={(e) => setRtspUrl(e.target.value)}
              placeholder={
                mode === "edit"
                  ? "***"
                  : t("cameras.hints.rtspCreate")
              }
              autoComplete="off"
              spellCheck={false}
              style={inputStyle}
            />
          </Field>

          {/* P28.5b: worker + display toggles */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <ToggleRow
              checked={workerEnabled}
              onChange={setWorkerEnabled}
              label={t("cameras.fields.workerEnabled")}
              hint={t("cameras.hints.workerEnabled")}
            />
            <ToggleRow
              checked={displayEnabled}
              onChange={setDisplayEnabled}
              label={t("cameras.fields.displayEnabled")}
              hint={t("cameras.hints.displayEnabled")}
            />
            <ToggleRow
              checked={detectionEnabled}
              onChange={setDetectionEnabled}
              label={t("cameras.fields.detectionEnabled")}
              hint={t("cameras.hints.detectionEnabled")}
            />
            <ToggleRow
              checked={clipRecordingEnabled}
              onChange={setClipRecordingEnabled}
              label={t("cameras.fields.clipRecordingEnabled")}
              hint={t("cameras.hints.clipRecordingEnabled")}
            />
            {/* Migration 0052 — clip detection source. Disabled UI
                hint when clip recording is off, but the value still
                round-trips so toggling recording back on preserves
                the operator's choice. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                opacity: clipRecordingEnabled ? 1 : 0.55,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--text-tertiary)",
                }}
              >
                {t("cameras.fields.clipDetectionSource")}
              </span>
              <div
                role="radiogroup"
                aria-label={
                  t("cameras.fields.clipDetectionSource") as string
                }
                style={{ display: "flex", gap: 12, flexWrap: "wrap" }}
              >
                {CLIP_DETECTION_SOURCES.map((s) => (
                  <label
                    key={s}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: clipRecordingEnabled
                        ? "pointer"
                        : "not-allowed",
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="radio"
                      name="clip_detection_source"
                      value={s}
                      checked={clipDetectionSource === s}
                      disabled={!clipRecordingEnabled}
                      onChange={() =>
                        setClipDetectionSource(s as ClipDetectionSource)
                      }
                    />
                    {t(`cameras.clipSource.${s}.label`)}
                  </label>
                ))}
              </div>
              <span className="text-xs text-dim">
                {t(`cameras.clipSource.${clipDetectionSource}.hint`)}
              </span>
            </div>
          </div>

          {/* P28.5b: capture settings (collapsed by default) */}
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            aria-expanded={showSettings}
            style={{
              padding: "8px 10px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: "var(--text)",
              fontSize: 12.5,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Icon name={showSettings ? "chevronDown" : "chevronRight"} size={12} />
            {t("cameras.fields.captureSettings")}
          </button>

          {showSettings && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                padding: "10px 12px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-sunken)",
              }}
            >
              <Field
                label={t("cameras.fields.maxFacesPerEvent")}
                hint={t("cameras.hints.maxFacesPerEvent")}
              >
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={config.max_faces_per_event}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      max_faces_per_event: clamp(parseInt(e.target.value, 10) || 1, 1, 50),
                    })
                  }
                  style={inputStyle}
                />
              </Field>

              <Field
                label={t("cameras.fields.maxEventDurationSec")}
                hint={t("cameras.hints.maxEventDurationSec")}
              >
                <input
                  type="number"
                  min={5}
                  max={600}
                  value={config.max_event_duration_sec}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      max_event_duration_sec: clamp(
                        parseInt(e.target.value, 10) || 5,
                        5,
                        600,
                      ),
                    })
                  }
                  style={inputStyle}
                />
              </Field>

              {/* min_face_quality_to_save slider removed — runtime
                  no-op since the fix-detector-mode-preflight cleanup.
                  Detector-level filtering (min_det_score +
                  min_face_pixels) already happens upstream; the
                  absolute post-detection threshold rejected legitimate
                  distant faces. The field stays on CaptureConfig for
                  back-compat with shipped migration 0027 but no UI is
                  surfaced. See docs/phases/fix-detector-mode-
                  preflight.md Layer 2. */}

              <ToggleRow
                checked={config.save_full_frames}
                onChange={(v) => setConfig({ ...config, save_full_frames: v })}
                label={t("cameras.fields.saveFullFrames")}
                hint={t("cameras.hints.saveFullFrames")}
              />
            </div>
          )}

          {error && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
              }}
            >
              {error}
            </div>
          )}

          {/* P28.8: read-only hardware details + auto-detected fields.
              Edit-affordances live on the Operations / Workers page so
              everything related to hardware sits in one place. */}
          {mode === "edit" && initial && (
            <div
              style={{
                marginTop: 8,
                padding: "10px 12px",
                background: "var(--bg-sunken)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  fontWeight: 600,
                  color: "var(--text-tertiary)",
                  marginBottom: 4,
                }}
              >
                {t("cameras.fields.hardwareDetails") as string}
              </div>
              <div className="mono text-xs">
                {[
                  initial.detected_resolution_w && initial.detected_resolution_h
                    ? `${initial.detected_resolution_w}×${initial.detected_resolution_h}`
                    : null,
                  initial.detected_codec,
                  initial.detected_fps ? `${initial.detected_fps} fps` : null,
                  initial.brand
                    ? initial.brand + (initial.model ? ` ${initial.model}` : "")
                    : null,
                  initial.mount_location,
                ]
                  .filter(Boolean)
                  .join(" · ") || (t("cameras.fields.hardwareEmpty") as string)}
              </div>
              <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                {t("cameras.fields.hardwareEditHint") as string}
              </div>
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            <Icon name="check" size={12} />
            {submitting
              ? t("common.saving")
              : mode === "create"
                ? t("common.add")
                : t("common.save")}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
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

function Field({
  label,
  hint,
  children,
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
