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

import { Icon } from "../../shell/Icon";
import { useCreateCamera, usePatchCamera } from "./hooks";
import {
  DEFAULT_CAPTURE_CONFIG,
  type Camera,
  type CameraCreateInput,
  type CameraPatchInput,
  type CaptureConfig,
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
  const [workerEnabled, setWorkerEnabled] = useState(
    initial?.worker_enabled ?? true,
  );
  const [displayEnabled, setDisplayEnabled] = useState(
    initial?.display_enabled ?? true,
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
    setWorkerEnabled(initial?.worker_enabled ?? true);
    setDisplayEnabled(initial?.display_enabled ?? true);
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
        const input: CameraCreateInput = {
          name: name.trim(),
          location: location.trim(),
          rtsp_url: rtspUrl.trim(),
          worker_enabled: workerEnabled,
          display_enabled: displayEnabled,
          capture_config: config,
        };
        await create.mutateAsync(input);
      } else {
        if (!initial) return;
        const patchBody: CameraPatchInput = {};
        if (name.trim() !== initial.name) patchBody.name = name.trim();
        if (location.trim() !== initial.location) patchBody.location = location.trim();
        if (workerEnabled !== initial.worker_enabled) {
          patchBody.worker_enabled = workerEnabled;
        }
        if (displayEnabled !== initial.display_enabled) {
          patchBody.display_enabled = displayEnabled;
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
    <>
      <div className="drawer-scrim" onClick={onClose} />
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
          <Field label={t("cameras.fields.name")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("cameras.placeholders.name")}
              style={inputStyle}
              autoFocus
            />
          </Field>

          <Field label={t("cameras.fields.location")}>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("cameras.placeholders.location")}
              style={inputStyle}
            />
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

              <Field
                label={t("cameras.fields.minFaceQualityToSave")}
                hint={t("cameras.hints.minFaceQualityToSave")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.min_face_quality_to_save}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        min_face_quality_to_save: parseFloat(e.target.value),
                      })
                    }
                    style={{ flex: 1 }}
                  />
                  <span
                    className="mono text-sm"
                    style={{ width: 40, textAlign: "end" }}
                  >
                    {config.min_face_quality_to_save.toFixed(2)}
                  </span>
                </div>
              </Field>

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
    </>
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
