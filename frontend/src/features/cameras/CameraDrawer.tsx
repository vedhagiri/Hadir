// Add/Edit form drawer for a camera. The RTSP URL field is write-only
// in the UI — on edit we display ``***`` as a placeholder and only send
// ``rtsp_url`` if the user actually types something new. That preserves
// the backend rule that the stored cipher is left untouched when the
// field is omitted from PATCH.

import { useEffect, useState } from "react";

import { Icon } from "../../shell/Icon";
import { useCreateCamera, usePatchCamera } from "./hooks";
import type { Camera, CameraCreateInput, CameraPatchInput } from "./types";

interface Props {
  mode: "create" | "edit";
  initial: Camera | null;
  onClose: () => void;
}

export function CameraDrawer({ mode, initial, onClose }: Props) {
  const create = useCreateCamera();
  const patch = usePatchCamera();

  const [name, setName] = useState(initial?.name ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [rtspUrl, setRtspUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(initial?.name ?? "");
    setLocation(initial?.location ?? "");
    setEnabled(initial?.enabled ?? true);
    setRtspUrl("");
    setError(null);
  }, [initial]);

  const submitting = create.isPending || patch.isPending;

  const submit = async () => {
    setError(null);
    try {
      if (mode === "create") {
        if (!rtspUrl.trim()) {
          setError("RTSP URL is required.");
          return;
        }
        const input: CameraCreateInput = {
          name: name.trim(),
          location: location.trim(),
          rtsp_url: rtspUrl.trim(),
          enabled,
        };
        await create.mutateAsync(input);
      } else {
        if (!initial) return;
        const patchBody: CameraPatchInput = {};
        if (name.trim() !== initial.name) patchBody.name = name.trim();
        if (location.trim() !== initial.location) patchBody.location = location.trim();
        if (enabled !== initial.enabled) patchBody.enabled = enabled;
        if (rtspUrl.trim()) patchBody.rtsp_url = rtspUrl.trim();
        if (Object.keys(patchBody).length === 0) {
          onClose();
          return;
        }
        await patch.mutateAsync({ id: initial.id, patch: patchBody });
      }
      onClose();
    } catch {
      setError("Could not save camera. Check the RTSP URL and try again.");
    }
  };

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">Camera</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {mode === "create" ? "Add camera" : `Edit · ${initial?.name ?? ""}`}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="drawer-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lobby"
              style={inputStyle}
              autoFocus
            />
          </Field>

          <Field label="Location">
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. HQ · North entrance"
              style={inputStyle}
            />
          </Field>

          <Field
            label="RTSP URL"
            hint={
              mode === "edit"
                ? "Stored value kept as-is unless you type a new URL here."
                : "rtsp://user:pass@host:port/path"
            }
          >
            <input
              value={rtspUrl}
              onChange={(e) => setRtspUrl(e.target.value)}
              placeholder={mode === "edit" ? "***" : "rtsp://user:pass@host:port/path"}
              autoComplete="off"
              spellCheck={false}
              style={inputStyle}
            />
          </Field>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>

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
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            <Icon name="check" size={12} />
            {submitting ? "Saving…" : mode === "create" ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </>
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
