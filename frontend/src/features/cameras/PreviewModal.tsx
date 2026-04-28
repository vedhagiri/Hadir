// Preview modal: fetches a single frame from
// /api/cameras/{id}/preview, displays it, offers a Refresh button.
//
// The backend opens and releases the RTSP stream inside that one
// request — we never keep a socket open on the client side. Each
// refresh triggers a fresh fetch.

import { useCallback, useEffect, useState } from "react";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import type { Camera } from "./types";

interface Props {
  camera: Camera;
  onClose: () => void;
}

export function PreviewModal({ camera, onClose }: Props) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/cameras/${camera.id}/preview`, {
        credentials: "same-origin",
      });
      if (!resp.ok) {
        if (resp.status === 504) {
          setError("Preview timed out. The camera may be offline or unreachable.");
        } else {
          setError(`Preview failed (${resp.status}).`);
        }
        return;
      }
      const blob = await resp.blob();
      setImgUrl((prev) => {
        // Free the previous blob URL to keep the browser from pinning
        // old frames in memory across refreshes.
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
    } catch {
      setError("Preview failed. Try again.");
    } finally {
      setLoading(false);
    }
  }, [camera.id]);

  useEffect(() => {
    void load();
    return () => {
      setImgUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [load]);

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          // Backdrop painted by ModalShell's scrim; this wrapper just
          // handles centering layout.
          zIndex: 60,
          display: "grid",
          placeItems: "center",
        }}
        // Backdrop is presentation-only — close via the X button.
        // Operator-policy red line; see DrawerShell.
      >
      <div
        className="card"
        style={{
          width: "min(720px, 92vw)",
          maxHeight: "86vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="card-head">
          <div>
            <h3 className="card-title">Preview · {camera.name}</h3>
            <p className="card-sub">
              <span className="mono">{camera.rtsp_host}</span> · on-demand single frame
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div
          style={{
            padding: 16,
            background: "var(--bg-sunken)",
            display: "grid",
            placeItems: "center",
            minHeight: 240,
          }}
        >
          {loading && <span className="text-sm text-dim">Connecting to stream…</span>}
          {error && !loading && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          {!loading && !error && imgUrl && (
            <img
              src={imgUrl}
              alt={`Preview from ${camera.name}`}
              style={{
                maxWidth: "100%",
                maxHeight: "60vh",
                display: "block",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
              }}
            />
          )}
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={onClose} disabled={loading}>
            Close
          </button>
          <button className="btn btn-primary" onClick={load} disabled={loading}>
            <Icon name="activity" size={12} />
            {loading ? "Fetching…" : "Refresh"}
          </button>
        </div>
      </div>
      </div>
    </ModalShell>
  );
}
