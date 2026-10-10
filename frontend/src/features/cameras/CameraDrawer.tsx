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
import { extractApiError } from "../../api/client";

import {
  ChoiceCards,
  Field,
  FormFooter,
  FormHeader,
  FormNotice,
  FormSection,
  SwitchField,
} from "../../components/FormKit";
import { Icon } from "../../shell/Icon";
import { BrandLogo } from "./BrandLogo";
import "./coreUi";
import { useCreateCamera, usePatchCamera } from "./hooks";
import {
  BRAND_OPTIONS,
  DEFAULT_CAPTURE_CONFIG,
  ZONE_OPTIONS,
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
  const [zone, setZone] = useState(initial?.zone ?? "");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  // New cameras default every pipeline switch to OFF. Operator
  // explicitly turns on what they want after adding the row. Edit
  // mode honours whatever the persisted row already carries.
  // Defaults for a brand-new camera: every operational toggle is ON
  // so the camera is immediately useful after Add. Edit mode keeps
  // the row's persisted value — the ``??`` fallback only fires when
  // ``initial`` is undefined (the Add path).
  const [workerEnabled, setWorkerEnabled] = useState(
    initial?.worker_enabled ?? true,
  );
  const [displayEnabled, setDisplayEnabled] = useState(
    initial?.display_enabled ?? true,
  );
  const [detectionEnabled, setDetectionEnabled] = useState(
    initial?.detection_enabled ?? true,
  );
  // Migration 0075 — per-camera recording mode (save_clips | logs_only).
  // 'logs_only' is the system default (migration 0076).
  const [recordingMode, setRecordingMode] = useState<"save_clips" | "logs_only">(
    initial?.recording_mode ?? "logs_only",
  );
  const [config, setConfig] = useState<CaptureConfig>(
    initial?.capture_config ?? DEFAULT_CAPTURE_CONFIG,
  );
  const [rtspUrl, setRtspUrl] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string | undefined; rtsp?: string | undefined }>({});

  useEffect(() => {
    setName(initial?.name ?? "");
    setLocation(initial?.location ?? "");
    setZone(initial?.zone ?? "");
    setBrand(initial?.brand ?? "");
    setWorkerEnabled(initial?.worker_enabled ?? true);
    setDisplayEnabled(initial?.display_enabled ?? true);
    setDetectionEnabled(initial?.detection_enabled ?? true);
    setRecordingMode(initial?.recording_mode ?? "logs_only");
    setConfig(initial?.capture_config ?? DEFAULT_CAPTURE_CONFIG);
    setRtspUrl("");
    setShowSettings(false);
    setError(null);
    setFieldErrors({});
  }, [initial]);

  const submitting = create.isPending || patch.isPending;

  // Add Camera is enabled only after the two hard-required fields are filled.
  // Edit Save is always enabled (all required fields were set at create time).
  const canSubmit =
    mode === "edit"
      ? !submitting
      : !submitting && name.trim().length > 0 && rtspUrl.trim().length > 0;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setError(null);
    setFieldErrors({});
    try {
      if (mode === "create") {
        if (!name.trim()) {
          setFieldErrors({ name: t("cameras.errors.nameRequired") });
          return;
        }
        if (!rtspUrl.trim()) {
          setFieldErrors({ rtsp: t("cameras.errors.rtspRequired") });
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
          recording_mode: recordingMode,
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
        if (recordingMode !== initial.recording_mode) {
          patchBody.recording_mode = recordingMode;
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
    } catch (err) {
      // Surface the backend's actual message (e.g. duplicate RTSP URL
      // 409 with {field, message}) instead of a generic "save failed".
      // ``extractApiError`` knows about both the plain-string and the
      // structured {field, message} shapes used across Maugood.
      setError(extractApiError(err, t("cameras.errors.saveFailed")));
    }
  };

  const hardwareSummary =
    mode === "edit" && initial
      ? [
          initial.detected_resolution_w && initial.detected_resolution_h
            ? `${initial.detected_resolution_w}×${initial.detected_resolution_h}`
            : null,
          initial.detected_codec,
          initial.detected_fps ? `${initial.detected_fps} fps` : null,
          initial.brand ? initial.brand + (initial.model ? ` ${initial.model}` : "") : null,
          initial.mount_location,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  return (
    <DrawerShell onClose={onClose}>
      <form className="drawer fk-drawer" onSubmit={(e) => void submit(e)}>
        <FormHeader
          icon={<Icon name="camera" size={18} />}
          title={
            mode === "create"
              ? t("cameras.addTitle")
              : t("cameras.drawer.editTitle", { defaultValue: "Edit camera" })
          }
          subtitle={
            mode === "create"
              ? t("cameras.drawer.addSubtitle", {
                  defaultValue: "Connect an RTSP stream and choose what the pipeline does with it.",
                })
              : t("cameras.drawer.editSubtitle", {
                  defaultValue: "Update {{name}}'s connection, pipeline switches and capture settings.",
                  name: initial?.name ?? "",
                })
          }
          onClose={onClose}
        />

        <div className="drawer-body fk-body">
          {error && <FormNotice tone="danger">{error}</FormNotice>}

          <FormSection
            step={1}
            title={t("cameras.sections.identity", { defaultValue: "Identity" })}
            description={t("cameras.drawer.identityDesc", {
              defaultValue: "How this camera is named and grouped across lists and reports.",
            })}
          >
            {/* Running camera code — surfaced as a read-only value on
                edit (auto-assigned on create, immutable in this UI). */}
            {mode === "edit" && initial?.camera_code && (
              <Field label={t("cameras.fields.cameraCode")} span={2}>
                <div className="co-readonly mono">{initial.camera_code}</div>
              </Field>
            )}

            <Field
              label={t("cameras.fields.name")}
              htmlFor="cam-name"
              required={mode === "create"}
              error={fieldErrors.name}
            >
              <input
                id="cam-name"
                className="input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setFieldErrors((p) => ({ ...p, name: undefined }));
                }}
                placeholder={t("cameras.placeholders.name")}
                autoFocus
                maxLength={120}
              />
            </Field>

            <Field label={t("cameras.fields.location")} htmlFor="cam-location">
              <input
                id="cam-location"
                className="input"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={t("cameras.placeholders.location")}
                maxLength={200}
              />
            </Field>

            <Field label={t("cameras.fields.zone")} htmlFor="cam-zone" help={t("cameras.hints.zone")}>
              <select id="cam-zone" className="select" value={zone} onChange={(e) => setZone(e.target.value)}>
                <option value="">{t("cameras.fields.zoneNone") as string}</option>
                {ZONE_OPTIONS.map((z) => (
                  <option key={z} value={z}>
                    {t(`cameras.zone.${z}`, { defaultValue: z }) as string}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t("cameras.brand")} htmlFor="cam-brand" help={t("cameras.brandHint")}>
              <div className="co-inline">
                <BrandLogo brand={brand && brand !== "Others" ? brand : null} size={28} />
                <select id="cam-brand" className="select" value={brand} onChange={(e) => setBrand(e.target.value)}>
                  <option value="">{t("cameras.brandPlaceholder") as string}</option>
                  {BRAND_OPTIONS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </FormSection>

          <FormSection
            step={2}
            title={t("cameras.sections.connection", { defaultValue: "Connection" })}
            description={t("cameras.drawer.connectionDesc", {
              defaultValue: "The stream address. It is encrypted at rest and never shown again after saving.",
            })}
          >
            <Field
              label={t("cameras.fields.rtspUrl")}
              htmlFor="cam-rtsp"
              required={mode === "create"}
              span={2}
              error={fieldErrors.rtsp}
              help={
                mode === "edit"
                  ? t("cameras.hints.rtspEdit")
                  : t("cameras.drawer.rtspCreateHelp", {
                      defaultValue: "Include the username and password if the camera needs them.",
                    })
              }
            >
              <input
                id="cam-rtsp"
                className="input mono"
                value={rtspUrl}
                onChange={(e) => {
                  setRtspUrl(e.target.value);
                  setFieldErrors((p) => ({ ...p, rtsp: undefined }));
                }}
                placeholder={
                  mode === "edit"
                    ? t("cameras.drawer.rtspStored", { defaultValue: "•••••• stored — type to replace" })
                    : t("cameras.hints.rtspCreate")
                }
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </FormSection>

          {/* P28.5b: worker + display toggles */}
          <FormSection
            step={3}
            title={t("cameras.sections.pipeline", { defaultValue: "Pipeline" })}
            description={t("cameras.drawer.pipelineDesc", {
              defaultValue: "Turn each stage on or off, and choose whether video is kept.",
            })}
          >
            <SwitchField
              id="cam-worker"
              checked={workerEnabled}
              onChange={setWorkerEnabled}
              label={t("cameras.fields.workerEnabled")}
              description={t("cameras.hints.workerEnabled")}
            />
            <SwitchField
              id="cam-display"
              checked={displayEnabled}
              onChange={setDisplayEnabled}
              label={t("cameras.fields.displayEnabled")}
              description={t("cameras.hints.displayEnabled")}
            />
            <SwitchField
              id="cam-detection"
              checked={detectionEnabled}
              onChange={setDetectionEnabled}
              label={t("cameras.fields.detectionEnabled")}
              description={t("cameras.hints.detectionEnabled")}
            />
            <Field label={t("cameras.recordingMode")} span={2} help={t("cameras.recordingModeHint")}>
              <ChoiceCards<"save_clips" | "logs_only">
                label={t("cameras.recordingMode")}
                value={recordingMode}
                onChange={setRecordingMode}
                options={[
                  {
                    value: "logs_only",
                    title: t("cameras.recordingModeLogsOnly") as string,
                    description: t("cameras.drawer.logsOnlyDesc", {
                      defaultValue: "Detection events only. No video is stored.",
                    }),
                    icon: <Icon name="fileText" size={16} />,
                  },
                  {
                    value: "save_clips",
                    title: t("cameras.recordingModeSaveClips") as string,
                    description: t("cameras.drawer.saveClipsDesc", {
                      defaultValue: "Records MP4 clips alongside events. Uses more disk.",
                    }),
                    icon: <Icon name="videocam" size={16} />,
                  },
                ]}
              />
            </Field>
          </FormSection>

          {/* P28.5b: capture settings (collapsed by default) */}
          <FormSection
            step={4}
            title={t("cameras.fields.captureSettings")}
            description={t("cameras.drawer.captureDesc", {
              defaultValue: "Advanced. The defaults suit most cameras.",
            })}
            aside={
              <button
                type="button"
                className="btn btn-sm btn-ghost co-disclosure-btn"
                onClick={() => setShowSettings((v) => !v)}
                aria-expanded={showSettings}
              >
                {showSettings
                  ? t("cameras.drawer.hideSettings", { defaultValue: "Hide" })
                  : t("cameras.drawer.showSettings", { defaultValue: "Show" })}
                <span className="co-disclosure-chev" aria-hidden>
                  <Icon name="chevronDown" size={13} />
                </span>
              </button>
            }
          >
            {showSettings && (
              <>
                <Field
                  label={t("cameras.fields.maxFacesPerEvent")}
                  htmlFor="cam-max-faces"
                  help={t("cameras.hints.maxFacesPerEvent")}
                >
                  <input
                    id="cam-max-faces"
                    className="input"
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
                  />
                </Field>

                <Field
                  label={t("cameras.fields.maxEventDurationSec")}
                  htmlFor="cam-max-duration"
                  help={t("cameras.hints.maxEventDurationSec")}
                >
                  <input
                    id="cam-max-duration"
                    className="input"
                    type="number"
                    min={5}
                    max={600}
                    value={config.max_event_duration_sec}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        max_event_duration_sec: clamp(parseInt(e.target.value, 10) || 5, 5, 600),
                      })
                    }
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

                <SwitchField
                  id="cam-full-frames"
                  checked={config.save_full_frames}
                  onChange={(v) => setConfig({ ...config, save_full_frames: v })}
                  label={t("cameras.fields.saveFullFrames")}
                  description={t("cameras.hints.saveFullFrames")}
                />
              </>
            )}
          </FormSection>

          {/* P28.8: read-only hardware details + auto-detected fields.
              Edit-affordances live on the Operations / Workers page so
              everything related to hardware sits in one place. */}
          {mode === "edit" && initial && (
            <FormSection
              step={5}
              title={t("cameras.fields.hardwareDetails") as string}
              description={t("cameras.fields.hardwareEditHint") as string}
              columns={1}
            >
              <div className="co-readonly mono">
                {hardwareSummary || (t("cameras.fields.hardwareEmpty") as string)}
              </div>
            </FormSection>
          )}
        </div>

        <FormFooter
          onCancel={onClose}
          submitLabel={mode === "create" ? t("cameras.addTitle") : t("common.save")}
          submittingLabel={t("common.saving")}
          submitting={submitting}
          canSubmit={canSubmit}
        />
      </form>
    </DrawerShell>
  );
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
