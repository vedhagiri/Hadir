// Cameras list page — Admin only.
// Layout mirrors the design's page-header + card-wrapped table pattern.
// Each row has per-row Preview / Edit / Delete actions. The RTSP URL
// never appears in the UI — we show the stripped ``rtsp_host`` only.

import { useState } from "react";

import { Icon } from "../../shell/Icon";
import { CameraDrawer } from "./CameraDrawer";
import { PreviewModal } from "./PreviewModal";
import { useCameras, useDeleteCamera, usePatchCamera } from "./hooks";
import type { Camera } from "./types";

export function CamerasPage() {
  const list = useCameras();
  const del = useDeleteCamera();
  const patch = usePatchCamera();
  const [drawerMode, setDrawerMode] = useState<"create" | "edit" | null>(null);
  const [editTarget, setEditTarget] = useState<Camera | null>(null);
  const [previewTarget, setPreviewTarget] = useState<Camera | null>(null);

  const openAdd = () => {
    setEditTarget(null);
    setDrawerMode("create");
  };
  const openEdit = (cam: Camera) => {
    setEditTarget(cam);
    setDrawerMode("edit");
  };
  const closeDrawer = () => {
    setDrawerMode(null);
    setEditTarget(null);
  };

  const toggleWorkerEnabled = (cam: Camera) => {
    patch.mutate({
      id: cam.id,
      patch: { worker_enabled: !cam.worker_enabled },
    });
  };
  const toggleDisplayEnabled = (cam: Camera) => {
    patch.mutate({
      id: cam.id,
      patch: { display_enabled: !cam.display_enabled },
    });
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Cameras</h1>
          <p className="page-sub">
            {list.data
              ? `${list.data.items.length} camera${list.data.items.length === 1 ? "" : "s"}`
              : "—"}
            {" · on-demand preview only · background capture arrives in P8"}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openAdd}>
            <Icon name="plus" size={12} />
            Add camera
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">All cameras</h3>
          <div className="text-xs text-dim">
            RTSP credentials are encrypted at rest and never shown in the UI.
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Location</th>
              <th>Host</th>
              <th>Worker</th>
              <th>Display</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  Loading…
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={6}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  Could not load cameras.
                </td>
              </tr>
            )}
            {list.data?.items.map((cam) => (
              <tr key={cam.id}>
                <td style={{ fontWeight: 500 }}>{cam.name}</td>
                <td className="text-sm">{cam.location || "—"}</td>
                <td className="mono text-sm">{cam.rtsp_host}</td>
                <td>
                  <button
                    className={`pill ${cam.worker_enabled ? "pill-success" : "pill-neutral"}`}
                    onClick={() => toggleWorkerEnabled(cam)}
                    style={{ cursor: "pointer", border: "none" }}
                    title="Click to toggle worker on/off"
                  >
                    {cam.worker_enabled ? "on" : "off"}
                  </button>
                </td>
                <td>
                  <button
                    className={`pill ${cam.display_enabled ? "pill-success" : "pill-neutral"}`}
                    onClick={() => toggleDisplayEnabled(cam)}
                    style={{ cursor: "pointer", border: "none" }}
                    title="Click to toggle display on/off"
                  >
                    {cam.display_enabled ? "on" : "off"}
                  </button>
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => setPreviewTarget(cam)}
                    >
                      <Icon name="activity" size={11} />
                      Preview
                    </button>
                    <button className="btn btn-sm" onClick={() => openEdit(cam)}>
                      <Icon name="settings" size={11} />
                      Edit
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        if (confirm(`Delete camera '${cam.name}'?`)) del.mutate(cam.id);
                      }}
                    >
                      <Icon name="x" size={11} />
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && !list.isLoading && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  No cameras yet. Add one to see its preview frame.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawerMode !== null && (
        <CameraDrawer
          mode={drawerMode}
          initial={editTarget}
          onClose={closeDrawer}
        />
      )}
      {previewTarget && (
        <PreviewModal
          camera={previewTarget}
          onClose={() => setPreviewTarget(null)}
        />
      )}
    </>
  );
}
