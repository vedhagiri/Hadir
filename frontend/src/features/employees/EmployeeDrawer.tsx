// Right-sliding detail drawer. Structure mirrors the RecordDrawer pattern
// in design/pages.jsx — drawer-scrim + drawer > drawer-head + drawer-body
// + drawer-foot. Shows the employee's profile, department, status, and
// a gallery of reference photos (with angle labels) that can be added to
// via a drop zone.

import { useCallback, useState } from "react";

import { Icon } from "../../shell/Icon";
import {
  useDeletePhoto,
  useEmployeeDetail,
  useEmployeePhotoUpload,
  useEmployeePhotos,
} from "./hooks";
import type { PhotoAngle, PhotoIngestResult } from "./types";

const ANGLES: PhotoAngle[] = ["front", "left", "right", "other"];

interface Props {
  employeeId: number;
  onClose: () => void;
}

export function EmployeeDrawer({ employeeId, onClose }: Props) {
  const detail = useEmployeeDetail(employeeId);
  const photos = useEmployeePhotos(employeeId);
  const upload = useEmployeePhotoUpload();
  const del = useDeletePhoto();

  const [angle, setAngle] = useState<PhotoAngle>("front");
  const [dragOver, setDragOver] = useState(false);
  const [lastResult, setLastResult] = useState<PhotoIngestResult | null>(null);

  const runUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      try {
        const r = await upload.mutateAsync({ employeeId, files, angle });
        setLastResult(r);
      } catch {
        // error surfaces via mutation state
      }
    },
    [upload, employeeId, angle],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
        f.type.startsWith("image/") || /\.(jpe?g|png)$/i.test(f.name),
      );
      void runUpload(files);
    },
    [runUpload],
  );

  const emp = detail.data;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">Employee</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {emp ? emp.full_name : "Loading…"}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="drawer-body">
          {!emp ? (
            <div className="text-sm text-dim">Loading employee…</div>
          ) : (
            <>
              {/* Profile block */}
              <div
                className="flex items-center gap-3"
                style={{ marginBottom: 16 }}
              >
                <div
                  className="avatar"
                  style={{ width: 46, height: 46, fontSize: 16 }}
                >
                  {initials(emp.full_name)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {emp.full_name}
                  </div>
                  <div className="text-sm text-dim mono">
                    {emp.employee_code}
                  </div>
                  <div className="flex gap-2" style={{ marginTop: 4 }}>
                    <span className="pill pill-neutral">
                      {emp.department.name}
                    </span>
                    <span
                      className={`pill ${emp.status === "active" ? "pill-success" : "pill-warning"}`}
                    >
                      {emp.status}
                    </span>
                  </div>
                </div>
              </div>

              <div
                className="grid"
                style={{
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                  marginBottom: 16,
                }}
              >
                <Fact label="Email" value={emp.email ?? "—"} mono />
                <Fact label="Department code" value={emp.department.code} mono />
                <Fact label="Photos" value={String(emp.photo_count)} />
                <Fact
                  label="Created"
                  value={new Date(emp.created_at).toLocaleString()}
                />
              </div>

              {/* Photo gallery */}
              <SectionLabel>Reference photos</SectionLabel>
              {photos.isLoading ? (
                <div className="text-sm text-dim">Loading photos…</div>
              ) : photos.data && photos.data.items.length > 0 ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 8,
                    marginBottom: 16,
                  }}
                >
                  {photos.data.items.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        overflow: "hidden",
                        background: "var(--bg-sunken)",
                      }}
                    >
                      <img
                        src={`/api/employees/${employeeId}/photos/${p.id}/image`}
                        alt={`${emp.employee_code} ${p.angle}`}
                        style={{
                          display: "block",
                          width: "100%",
                          aspectRatio: "1 / 1",
                          objectFit: "cover",
                        }}
                      />
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "4px 6px",
                        }}
                      >
                        <span className="mono text-xs">{p.angle}</span>
                        <button
                          className="icon-btn"
                          style={{ width: 22, height: 22 }}
                          title="Remove photo"
                          onClick={() =>
                            del.mutate({ employeeId, photoId: p.id })
                          }
                        >
                          <Icon name="x" size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="text-sm text-dim"
                  style={{ marginBottom: 16 }}
                >
                  No reference photos yet. Drop some below to ingest.
                </div>
              )}

              {/* Upload zone */}
              <SectionLabel>Add photos</SectionLabel>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {ANGLES.map((a) => (
                  <button
                    key={a}
                    className={`pill ${angle === a ? "pill-accent" : "pill-neutral"}`}
                    onClick={() => setAngle(a)}
                    style={{ cursor: "pointer", border: "none" }}
                    type="button"
                  >
                    {a}
                  </button>
                ))}
              </div>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                style={{
                  border: `1px dashed ${dragOver ? "var(--accent-border)" : "var(--border-strong)"}`,
                  background: dragOver ? "var(--accent-soft)" : "var(--bg-sunken)",
                  borderRadius: "var(--radius)",
                  padding: 18,
                  textAlign: "center",
                  fontSize: 12.5,
                  color: "var(--text-secondary)",
                  marginBottom: 8,
                }}
              >
                <div style={{ marginBottom: 6 }}>
                  <Icon name="upload" size={16} />
                </div>
                Drop images here, or{" "}
                <label
                  style={{
                    textDecoration: "underline",
                    cursor: "pointer",
                    color: "var(--text)",
                  }}
                >
                  choose files
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(e) =>
                      void runUpload(Array.from(e.target.files ?? []))
                    }
                    style={{ display: "none" }}
                  />
                </label>
                <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                  Angle: <span className="mono">{angle}</span>
                  {upload.isPending ? " · uploading…" : ""}
                </div>
              </div>

              {lastResult && (
                <div
                  style={{
                    background: "var(--bg-sunken)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "8px 10px",
                    fontSize: 12,
                  }}
                >
                  <div>
                    Accepted {lastResult.accepted.length} ·{" "}
                    Rejected {lastResult.rejected.length}
                  </div>
                  {lastResult.rejected.length > 0 && (
                    <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                      {lastResult.rejected.map((r) => (
                        <li key={r.filename}>
                          <span className="mono">{r.filename}</span> — {r.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        background: "var(--bg-sunken)",
        borderRadius: 8,
      }}
    >
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        className={mono ? "mono" : ""}
        style={{ fontSize: 13, marginTop: 2 }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-tertiary)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}
