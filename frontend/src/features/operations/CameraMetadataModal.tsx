// Manual camera metadata edit modal (brand / model / mount_location).
// Auto-detected fields are read-only with a "Detected at" timestamp.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { Icon } from "../../shell/Icon";
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

const COMMON_BRANDS = [
  "Hikvision",
  "Dahua",
  "Axis",
  "Bosch",
  "Avigilon",
  "Hanwha",
  "Uniview",
  "Pelco",
];

export function CameraMetadataModal({
  cameraId,
  initial,
  detected,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const patch = usePatchCameraMetadata();

  const [brand, setBrand] = useState(initial.brand ?? "");
  const [model, setModel] = useState(initial.model ?? "");
  const [mountLocation, setMountLocation] = useState(
    initial.mount_location ?? "",
  );
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
        setError(typeof detail === "string" ? detail : `Error ${e.status}`);
      } else {
        setError("Could not save");
      }
    }
  };

  const detectedSummary: string[] = [];
  if (detected.resolution_w && detected.resolution_h) {
    detectedSummary.push(`${detected.resolution_w}×${detected.resolution_h}`);
  }
  if (detected.codec) detectedSummary.push(detected.codec);
  if (detected.fps) detectedSummary.push(`${detected.fps} fps`);

  return (
    <>
      <div
        className="drawer-scrim"
        onClick={onClose}
        style={{ zIndex: 50 }}
      />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          top: "50%",
          insetInlineStart: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 51,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          padding: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            {t("operations.metadata.modalTitle") as string}
          </h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close") as string}
          >
            <Icon name="x" size={13} />
          </button>
        </div>

        {/* Auto-detected (read-only) */}
        <div
          style={{
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: "8px 10px",
            marginBottom: 14,
            fontSize: 12,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-tertiary)",
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            {t("operations.metadata.autoDetected") as string}
          </div>
          <div className="mono">
            {detectedSummary.length > 0
              ? detectedSummary.join(" · ")
              : (t("operations.metadata.unavailable") as string)}
          </div>
          {detected.detected_at && (
            <div className="text-xs text-dim" style={{ marginTop: 4 }}>
              {t("operations.metadata.detectedAt") as string}{" "}
              {new Date(detected.detected_at).toLocaleString()}
            </div>
          )}
        </div>

        {/* Manual fields */}
        <Field label={t("operations.metadata.brand") as string}>
          <input
            list={`brand-suggest-${cameraId}`}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            maxLength={80}
            style={inputStyle}
          />
          <datalist id={`brand-suggest-${cameraId}`}>
            {COMMON_BRANDS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </Field>
        <Field label={t("operations.metadata.model") as string}>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            maxLength={120}
            style={inputStyle}
          />
        </Field>
        <Field label={t("operations.metadata.mountLocation") as string}>
          <textarea
            value={mountLocation}
            onChange={(e) => setMountLocation(e.target.value)}
            maxLength={200}
            rows={2}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Field>

        {error && (
          <div
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              padding: "6px 8px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
              marginTop: 8,
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
            marginTop: 16,
          }}
        >
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel") as string}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void onSave()}
            disabled={patch.isPending}
          >
            {t("common.save") as string}
          </button>
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label
        className="text-xs"
        style={{ fontWeight: 500, color: "var(--text-secondary)" }}
      >
        {label}
      </label>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
};
