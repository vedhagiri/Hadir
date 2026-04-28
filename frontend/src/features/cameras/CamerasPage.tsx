// Cameras list page — Admin only.
// Layout mirrors the design's page-header + card-wrapped table pattern.
// Per-row actions live in a vertical-3-dot kebab menu (Preview / Edit
// / Delete). Delete opens a confirmation modal before firing.
// The RTSP URL never appears in the UI — we show ``rtsp_host`` only.

import { useEffect, useRef, useState } from "react";

import { ModalShell } from "../../components/DrawerShell";
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
  const [deleteTarget, setDeleteTarget] = useState<Camera | null>(null);

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
  const toggleDetectionEnabled = (cam: Camera) => {
    patch.mutate({
      id: cam.id,
      patch: { detection_enabled: !cam.detection_enabled },
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
              <th style={{ width: 96 }}>ID</th>
              <th>Name</th>
              <th>Zone</th>
              <th>Location</th>
              <th>Host</th>
              <th style={{ width: 90 }}>Status</th>
              <th style={{ width: 110 }}>Events 24h</th>
              <th>Worker</th>
              <th>Display</th>
              <th>Detection</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={11} className="text-sm text-dim" style={{ padding: 16 }}>
                  Loading…
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={11}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  Could not load cameras.
                </td>
              </tr>
            )}
            {list.data?.items.map((cam) => {
              const metadataLine = [
                cam.detected_resolution_w && cam.detected_resolution_h
                  ? `${cam.detected_resolution_w}×${cam.detected_resolution_h}`
                  : null,
                cam.brand,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
              <tr key={cam.id}>
                <td className="mono text-sm" style={{ fontWeight: 600 }}>
                  {cam.camera_code}
                </td>
                <td>
                  <div style={{ fontWeight: 500 }}>{cam.name}</div>
                  {metadataLine && (
                    <div
                      className="text-xs text-dim mono"
                      style={{ marginTop: 2 }}
                    >
                      {metadataLine}
                    </div>
                  )}
                </td>
                <td className="text-sm">
                  {cam.zone ? (
                    <span className="pill pill-neutral">{cam.zone}</span>
                  ) : (
                    <span className="text-xs text-dim">—</span>
                  )}
                </td>
                <td className="text-sm">{cam.location || "—"}</td>
                <td className="mono text-sm">{cam.rtsp_host}</td>
                <td>
                  <StatusDot camera={cam} />
                </td>
                <td className="mono text-sm">
                  {cam.images_captured_24h.toLocaleString()}
                </td>
                <td>
                  <Switch
                    checked={cam.worker_enabled}
                    onChange={() => toggleWorkerEnabled(cam)}
                    title="Click to toggle worker on/off"
                  />
                </td>
                <td>
                  <Switch
                    checked={cam.display_enabled}
                    onChange={() => toggleDisplayEnabled(cam)}
                    title="Click to toggle display on/off"
                  />
                </td>
                <td>
                  <Switch
                    checked={cam.detection_enabled}
                    onChange={() => toggleDetectionEnabled(cam)}
                    title="Click to toggle face detection on/off (worker keeps streaming)"
                  />
                </td>
                <td style={{ textAlign: "right" }}>
                  <RowActionsMenu
                    onPreview={() => setPreviewTarget(cam)}
                    onEdit={() => openEdit(cam)}
                    onDelete={() => setDeleteTarget(cam)}
                  />
                </td>
              </tr>
              );
            })}
            {list.data && list.data.items.length === 0 && !list.isLoading && (
              <tr>
                <td colSpan={11} className="text-sm text-dim" style={{ padding: 16 }}>
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
      {deleteTarget && (
        <DeleteConfirmModal
          camera={deleteTarget}
          busy={del.isPending}
          onConfirm={() => {
            del.mutate(deleteTarget.id, {
              onSuccess: () => setDeleteTarget(null),
            });
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}

/**
 * iOS-style toggle switch — 36×20 pill with a sliding thumb. Used in
 * the Worker / Display / Detection columns of the Cameras table so
 * each row has a tactile on/off control instead of a static pill.
 * Background flips between accent (on) and the design's neutral
 * border tone (off); thumb translates to the right when checked.
 */
function Switch({
  checked,
  onChange,
  title,
}: {
  checked: boolean;
  onChange: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      title={title}
      style={{
        appearance: "none",
        width: 36,
        height: 20,
        borderRadius: 999,
        background: checked ? "var(--success)" : "var(--border)",
        border: "none",
        position: "relative",
        cursor: "pointer",
        padding: 0,
        display: "inline-block",
        transition: "background 120ms ease",
        outline: "none",
        verticalAlign: "middle",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          insetInlineStart: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "white",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          transition: "inset-inline-start 140ms ease",
        }}
      />
    </button>
  );
}

/**
 * Health pill — green when the camera is enabled AND its
 * ``last_seen_at`` is within the freshness window; red otherwise.
 * The freshness window is generous (3 minutes) so a brief network
 * blip doesn't flip the pill on a busy operator dashboard.
 */
function StatusDot({ camera }: { camera: Camera }) {
  const FRESH_MS = 3 * 60 * 1000;
  const lastMs = camera.last_seen_at
    ? new Date(camera.last_seen_at).getTime()
    : null;
  const fresh =
    camera.worker_enabled && lastMs !== null && Date.now() - lastMs < FRESH_MS;
  const label = !camera.worker_enabled
    ? "Off"
    : fresh
      ? "Online"
      : "Offline";
  const color = fresh
    ? "var(--success)"
    : camera.worker_enabled
      ? "var(--danger)"
      : "var(--text-tertiary)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--text)",
        fontWeight: 500,
      }}
      title={
        camera.last_seen_at
          ? `Last seen ${new Date(camera.last_seen_at).toLocaleString()}`
          : "Never seen"
      }
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 0 2px ${color}33`,
        }}
      />
      {label}
    </span>
  );
}

/**
 * Per-row kebab menu — vertical 3-dots trigger that drops a small
 * popover with Preview / Edit / Delete. Mirrors the Employees page's
 * RowActionsMenu shape so the two surfaces feel consistent. Click-
 * outside + Esc close the popover (it's a small menu, not a modal —
 * the operator-policy red line that bars Esc/backdrop on
 * drawers/modals doesn't extend here).
 */
function RowActionsMenu({
  onPreview,
  onEdit,
  onDelete,
}: {
  onPreview: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className="icon-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((s) => !s);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Row actions"
        title="Row actions"
      >
        <Icon name="moreVertical" size={14} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "100%",
            insetInlineEnd: 0,
            marginTop: 4,
            minWidth: 160,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 30,
            padding: 4,
          }}
        >
          <MenuItem icon="activity" label="Preview" onClick={pick(onPreview)} />
          <MenuItem icon="settings" label="Edit" onClick={pick(onEdit)} />
          <MenuItem
            icon="trash"
            label="Delete"
            onClick={pick(onDelete)}
            danger
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: "activity" | "settings" | "trash";
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        textAlign: "start",
        background: "transparent",
        color: danger ? "var(--danger-text)" : "var(--text)",
        border: "none",
        cursor: "pointer",
        borderRadius: "var(--radius-sm)",
        fontSize: 12.5,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-sunken)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}

/**
 * Delete-confirmation modal — explicit Cancel / Delete buttons; no
 * Esc / backdrop dismiss (operator-policy red line). Spells out the
 * camera name so the operator can't mistakenly delete the wrong row.
 */
function DeleteConfirmModal({
  camera,
  busy,
  onConfirm,
  onClose,
}: {
  camera: Camera;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg)",
            width: 460,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "var(--danger-soft)",
                display: "grid",
                placeItems: "center",
                color: "var(--danger-text)",
              }}
            >
              <Icon name="trash" size={14} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              Delete camera
            </div>
          </div>
          <div
            className="text-sm text-dim"
            style={{ marginBottom: 16, lineHeight: 1.5 }}
          >
            Permanently delete <strong style={{ color: "var(--text)" }}>{camera.name}</strong>?
            The capture worker for this camera will stop and its
            recording history stays in place. This action is audited
            but cannot be reversed.
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ background: "var(--danger)", color: "white" }}
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Delete camera"}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
