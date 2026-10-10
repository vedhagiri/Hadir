// Manual camera metadata edit modal (brand / model / mount_location).
// Auto-detected fields are read-only with a "Detected at" timestamp.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { Banner, ModalPanel } from "../system/opsUi";
import { usePatchCameraMetadata } from "./hooks";

interface Props {
  cameraId: number;
  initial: {
    brand: string | null;
    model: string | null;
    mount_location: string | null;
  };
  detected: {
    resolution_w: number | null;
    resolution_h: number | null;
    fps: number | null;
    codec: string | null;
    detected_at: string | null;
  };
  onClose: () => void;
}

const COMMON_BRANDS = ["Hikvision", "Dahua", "Axis", "Bosch", "Avigilon", "Hanwha", "Uniview", "Pelco"];

export function CameraMetadataModal({ cameraId, initial, detected, onClose }: Props) {
  const { t } = useTranslation();
  const patch = usePatchCameraMetadata();

  const [brand, setBrand] = useState(initial.brand ?? "");
  const [model, setModel] = useState(initial.model ?? "");
  const [mountLocation, setMountLocation] = useState(initial.mount_location ?? "");
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    setError(null);
    try {
      await patch.mutateAsync({
        cameraId,
        patch: {
          brand: brand.trim() || null,
          model: model.trim() || null,
          mount_location: mountLocation.trim() || null,
        },
      });
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string })?.detail;
        setError(typeof detail === "string" ? detail : t("operations.metadata.saveFailedStatus", { defaultValue: "Error {{status}}", status: e.status }) as string);
      } else {
        setError(t("operations.metadata.saveFailed", { defaultValue: "Could not save" }) as string);
      }
    }
  };

  const detectedSummary: string[] = [];
  if (detected.resolution_w && detected.resolution_h) {
    detectedSummary.push(`${detected.resolution_w}×${detected.resolution_h}`);
  }
  if (detected.codec) detectedSummary.push(detected.codec);
  if (detected.fps) detectedSummary.push(`${detected.fps} fps`);

  const title = t("operations.metadata.modalTitle") as string;

  return (
    <ModalShell onClose={onClose}>
      <ModalPanel
        title={title}
        ariaLabel={title}
        headActions={
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close") as string}>
            <Icon name="x" size={13} />
          </button>
        }
        footer={
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t("common.cancel") as string}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void onSave()} disabled={patch.isPending}>
              {t("common.save") as string}
            </button>
          </>
        }
      >
        {/* Auto-detected (read-only) */}
        <div className="ops-worker-row" style={{ display: "block", marginBottom: 16 }}>
          <div className="ops-section-label" style={{ marginBottom: 4 }}>{t("operations.metadata.autoDetected") as string}</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
            {detectedSummary.length > 0 ? detectedSummary.join(" · ") : (t("operations.metadata.unavailable") as string)}
          </div>
          {detected.detected_at && (
            <div className="text-xs text-dim" style={{ marginTop: 4 }}>
              {t("operations.metadata.detectedAt") as string} {new Date(detected.detected_at).toLocaleString()}
            </div>
          )}
        </div>

        {/* Manual fields */}
        <div className="ops-section-label">{t("operations.metadata.manualSection", { defaultValue: "Manual details" })}</div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor={`cam-brand-${cameraId}`}>{t("operations.metadata.brand") as string}</label>
          <input
            id={`cam-brand-${cameraId}`}
            className="input"
            list={`brand-suggest-${cameraId}`}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            maxLength={80}
            style={{ width: "100%" }}
          />
          <datalist id={`brand-suggest-${cameraId}`}>
            {COMMON_BRANDS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor={`cam-model-${cameraId}`}>{t("operations.metadata.model") as string}</label>
          <input id={`cam-model-${cameraId}`} className="input" value={model} onChange={(e) => setModel(e.target.value)} maxLength={120} style={{ width: "100%" }} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`cam-mount-${cameraId}`}>{t("operations.metadata.mountLocation") as string}</label>
          <textarea
            id={`cam-mount-${cameraId}`}
            className="textarea"
            value={mountLocation}
            onChange={(e) => setMountLocation(e.target.value)}
            maxLength={200}
            rows={2}
            style={{ width: "100%", minHeight: 64 }}
          />
        </div>

        {error && (
          <div style={{ marginTop: 12 }}>
            <Banner tone="danger" icon={<Icon name="info" size={14} />} role="alert">{error}</Banner>
          </div>
        )}
      </ModalPanel>
    </ModalShell>
  );
}
