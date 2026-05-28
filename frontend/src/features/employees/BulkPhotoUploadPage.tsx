// BulkPhotoUploadPage.tsx — Admin-only bulk employee photo ingestion.
// Three-phase workflow: select → review → results.
// Filename convention: {EMPLOYEE_CODE}_{angle}.jpg  (e.g. OM0097_front.jpg)

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { useBulkIngestPhotos } from "./hooks";
import type { Employee, EmployeeListResponse, PhotoAngle, PhotoIngestResult } from "./types";

// Backend caps page_size at 200; the bulk-upload review needs *every*
// employee to build the code→employee map, so fan through pages until
// we've drained the list.
const EMP_PAGE_SIZE = 200;

async function fetchAllEmployees(): Promise<Employee[]> {
  const out: Employee[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      include_inactive: "true",
      page: String(page),
      page_size: String(EMP_PAGE_SIZE),
      sort_by: "employee_code",
      sort_dir: "asc",
    });
    const res = await api<EmployeeListResponse>(`/api/employees?${params}`);
    out.push(...res.items);
    if (out.length >= res.total || res.items.length < EMP_PAGE_SIZE) break;
    page += 1;
  }
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACCEPTED_EXTS = /\.(jpe?g|png|webp)$/i;
const VALID_ANGLES: PhotoAngle[] = ["front", "left", "right", "other"];

function parseFilename(name: string): {
  code: string | null;
  angle: PhotoAngle | null;
  error: string | null;
} {
  const base = name.replace(ACCEPTED_EXTS, "").trim();
  for (const angle of VALID_ANGLES) {
    if (base.toLowerCase().endsWith(`_${angle}`)) {
      const code = base.slice(0, -(angle.length + 1)).toUpperCase();
      if (code.length > 0) return { code, angle, error: null };
    }
  }
  // bare code → infer "other"
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(base))
    return { code: base.toUpperCase(), angle: "other", error: null };
  return { code: null, angle: null, error: "Must be CODE_angle.jpg — e.g. OM0097_front.jpg" };
}

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = "upload" | "review" | "results";

interface ParsedFile {
  file: File;
  previewUrl: string;
  parsedCode: string | null;
  parsedAngle: PhotoAngle | null;
  parseError: string | null;
}

interface EmployeeGroup {
  code: string;
  employee: Employee | null;
  files: ParsedFile[];
}

// ─── Small shared components ──────────────────────────────────────────────────

function AnglePill({ angle }: { angle: PhotoAngle | null }) {
  if (!angle) return null;
  if (angle === "front") return <span className="pill pill-success">{angle}</span>;
  if (angle === "other") return <span className="pill">{angle}</span>;
  return <span className="pill pill-neutral">{angle}</span>;
}

// One file thumbnail — manages its own blob URL lifecycle.
function FileThumbnail({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const { code, angle, error } = parseFilename(file.name);

  useEffect(() => {
    const obj = URL.createObjectURL(file);
    setUrl(obj);
    return () => URL.revokeObjectURL(obj);
  }, [file]);

  return (
    <div>
      {/* Square image */}
      <div
        style={{
          aspectRatio: "1",
          borderRadius: 10,
          overflow: "hidden",
          background: "var(--bg-sunken)",
          border: error
            ? "1.5px solid var(--danger-text)"
            : "1.5px solid var(--border)",
          position: "relative",
        }}
      >
        {url && (
          <img
            src={url}
            alt={file.name}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        )}
        <button
          className="photo-remove"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          style={{ top: 5, insetInlineEnd: 5 }}
        >
          <Icon name="x" size={9} />
        </button>
      </div>

      {/* Meta below image */}
      <div style={{ marginTop: 5 }}>
        <p
          title={file.name}
          style={{
            margin: "0 0 3px",
            fontSize: 10,
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.name}
        </p>
        {error ? (
          <span className="pill pill-danger" style={{ fontSize: 9, padding: "0 5px" }}>
            invalid
          </span>
        ) : (
          <div style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {code}
            </span>
            <AnglePill angle={angle} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Phase 1: Upload ─────────────────────────────────────────────────────────

function UploadPhase({
  files,
  onAdd,
  onRemove,
  onClear,
  onReview,
}: {
  files: File[];
  onAdd: (f: File[]) => void;
  onRemove: (name: string) => void;
  onClear: () => void;
  onReview: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (list: FileList | File[]) => {
    const arr = Array.from(list).filter((f) => ACCEPTED_EXTS.test(f.name));
    onAdd(arr);
  };

  const invalidCount = files.filter((f) => parseFilename(f.name).error !== null).length;
  const totalMB = (files.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".jpg,.jpeg,.png,.webp"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) accept(e.target.files);
          e.target.value = "";
        }}
      />

      {/* ── Drop zone ── */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop employee photos here or click to choose files"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files);
        }}
        style={{
          border: `2px dashed ${dragging ? "var(--accent)" : "var(--border-strong)"}`,
          borderRadius: 16,
          padding: "60px 40px",
          textAlign: "center",
          cursor: "pointer",
          background: dragging ? "var(--accent-soft)" : "var(--bg-sunken)",
          transition: "border-color .15s, background .15s",
          userSelect: "none",
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: "50%",
            background: dragging ? "var(--accent)" : "var(--bg-elev)",
            border: `1px solid ${dragging ? "transparent" : "var(--border)"}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 22px",
            color: dragging ? "#fff" : "var(--text-tertiary)",
            transition: "all .15s",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <Icon name="camera" size={30} />
        </div>

        <h2
          style={{
            margin: "0 0 8px",
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "var(--text)",
            fontFamily: "var(--font-display)",
          }}
        >
          {dragging ? "Release to add photos" : "Drop employee photos here"}
        </h2>

        <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-secondary)" }}>
          Filename format:{" "}
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              background: "var(--bg-elev)",
              padding: "2px 7px",
              borderRadius: 4,
              border: "1px solid var(--border)",
            }}
          >
            OM0097_front.jpg
          </code>
          <span style={{ color: "var(--text-tertiary)", marginInlineStart: 6 }}>
            · front · left · right · other
          </span>
        </p>

        <p style={{ margin: "0 0 24px", fontSize: 12, color: "var(--text-tertiary)" }}>
          JPEG · PNG · WebP supported
        </p>

        <button
          className="btn"
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
          aria-label="Choose photo files"
        >
          Choose Files
        </button>
      </div>

      {/* ── Selected files ── */}
      {files.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-head">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <p className="card-title">
                {files.length} photo{files.length !== 1 ? "s" : ""} selected
              </p>
              <span className="pill">{totalMB} MB</span>
              {invalidCount > 0 && (
                <span className="pill pill-warning">
                  {invalidCount} invalid name{invalidCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-ghost btn-sm" onClick={onClear}>
                Clear all
              </button>
              <button
                className="btn btn-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  inputRef.current?.click();
                }}
                aria-label="Add more files"
              >
                + Add more
              </button>
              <button className="btn btn-sm btn-primary" onClick={onReview}>
                Review →
              </button>
            </div>
          </div>

          <div className="card-body">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
                gap: 14,
              }}
            >
              {files.map((f) => (
                <FileThumbnail key={f.name} file={f} onRemove={() => onRemove(f.name)} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Phase 2: Review ─────────────────────────────────────────────────────────

function ReviewPhase({
  groups,
  parseErrors,
  isLoadingEmployees,
  remaps,
  deselected,
  employeeMap,
  onToggleDeselect,
  onSetGroupDeselected,
  onApplyRemap,
  onUndoRemap,
  onSubmit,
  onBack,
  isUploading,
}: {
  groups: EmployeeGroup[];
  parseErrors: ParsedFile[];
  isLoadingEmployees: boolean;
  remaps: Map<string, string>;
  deselected: Set<string>;
  employeeMap: Map<string, Employee>;
  onToggleDeselect: (filename: string) => void;
  onSetGroupDeselected: (filenames: string[], remove: boolean) => void;
  onApplyRemap: (filename: string, newCode: string) => void;
  onUndoRemap: (filename: string, parsedCode: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  isUploading: boolean;
}) {
  const matched = groups.filter((g) => g.employee !== null);
  const unmatched = groups.filter((g) => g.employee === null);

  const matchedFiles = matched.flatMap((g) => g.files);
  const selectedCount = matchedFiles.filter(
    (pf) => !deselected.has(pf.file.name),
  ).length;
  const removedCount = matchedFiles.length - selectedCount;
  const unmatchedFileCount = unmatched.reduce((n, g) => n + g.files.length, 0);
  const readyEmployeeCount = matched.filter((g) =>
    g.files.some((pf) => !deselected.has(pf.file.name)),
  ).length;

  return (
    <div style={{ maxWidth: 940, margin: "0 auto" }}>
      {/* ── Action hero ── */}
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card-body" style={{ padding: "18px 22px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 200 }}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                }}
              >
                Ready to upload
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  marginTop: 4,
                }}
              >
                <span
                  style={{
                    fontSize: 34,
                    fontWeight: 700,
                    color:
                      selectedCount > 0
                        ? "var(--success-text)"
                        : "var(--text-tertiary)",
                    fontFamily: "var(--font-display)",
                    lineHeight: 1,
                  }}
                >
                  {selectedCount}
                </span>
                <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                  photo{selectedCount !== 1 ? "s" : ""} for{" "}
                  {readyEmployeeCount} employee
                  {readyEmployeeCount !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-ghost"
                onClick={onBack}
                disabled={isUploading}
              >
                ← Back
              </button>
              <button
                className="btn btn-primary"
                onClick={onSubmit}
                disabled={
                  selectedCount === 0 || isUploading || isLoadingEmployees
                }
                aria-busy={isUploading}
              >
                {isUploading
                  ? "Uploading…"
                  : `Upload ${selectedCount} photo${selectedCount !== 1 ? "s" : ""}`}
              </button>
            </div>
          </div>

          {/* Breakdown chips */}
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              marginTop: 14,
              paddingTop: 14,
              borderTop: "1px solid var(--border)",
            }}
          >
            <SummaryChip
              icon="✓"
              label={`selected${selectedCount !== 1 ? "" : ""}`}
              value={selectedCount}
              tone="success"
            />
            <SummaryChip
              icon="⊘"
              label="removed"
              value={removedCount}
              tone="neutral"
            />
            <SummaryChip
              icon="⚠"
              label="needs review"
              value={unmatchedFileCount}
              tone="warning"
            />
            <SummaryChip
              icon="✗"
              label="invalid"
              value={parseErrors.length}
              tone="danger"
            />
          </div>
        </div>
      </div>

      {/* Loading */}
      {isLoadingEmployees && (
        <div className="empty" style={{ paddingTop: 60 }}>
          <Icon name="activity" size={24} />
          <p style={{ marginTop: 10 }}>Looking up employees…</p>
        </div>
      )}

      {/* ── Matched employees ── */}
      {!isLoadingEmployees && matched.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <SectionTitle
            pill="✓ Matched"
            tone="success"
            count={matched.length}
            label="employee"
            sub="Click any photo to remove it from this upload. Use Remove all / Restore all to toggle a whole employee."
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 14,
            }}
          >
            {matched.map((group) => (
              <MatchedEmployeeCard
                key={group.code}
                group={group}
                deselected={deselected}
                onToggleDeselect={onToggleDeselect}
                onSetGroupDeselected={onSetGroupDeselected}
                onUndoRemap={onUndoRemap}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Unmatched codes ── */}
      {!isLoadingEmployees && unmatched.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <SectionTitle
            pill="⚠ Needs review"
            tone="warning"
            count={unmatched.length}
            label="code"
            sub="No employee found for these filenames. Enter the correct code to remap, or leave them — they will NOT be uploaded as-is."
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
            }}
          >
            {unmatched.map((group) => (
              <UnmatchedCard
                key={group.code}
                group={group}
                remaps={remaps}
                employeeMap={employeeMap}
                onApplyRemap={onApplyRemap}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Invalid filenames ── */}
      {!isLoadingEmployees && parseErrors.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <SectionTitle
            pill="✗ Invalid filenames"
            tone="danger"
            count={parseErrors.length}
            label="file"
            sub="These filenames don't match the {CODE}_{angle}.jpg convention and will be skipped."
          />
          <div className="card">
            <div className="card-body" style={{ padding: 0 }}>
              <table className="table table-compact" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {parseErrors.map((pf) => (
                    <tr key={pf.file.name}>
                      <td>
                        <code
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 12,
                            color: "var(--text)",
                          }}
                        >
                          {pf.file.name}
                        </code>
                      </td>
                      <td style={{ color: "var(--danger-text)", fontSize: 12 }}>
                        {pf.parseError}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Empty state when nothing to review ── */}
      {!isLoadingEmployees &&
        matched.length === 0 &&
        unmatched.length === 0 &&
        parseErrors.length === 0 && (
          <div className="empty" style={{ paddingTop: 60 }}>
            <Icon name="camera" size={32} />
            <p
              style={{
                marginTop: 12,
                fontSize: 14,
                color: "var(--text-secondary)",
              }}
            >
              No files to review. Go back and add some photos.
            </p>
          </div>
        )}
    </div>
  );
}

function SummaryChip({
  icon,
  label,
  value,
  tone,
}: {
  icon: string;
  label: string;
  value: number;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  const muted = value === 0;
  const palette: Record<
    "success" | "warning" | "danger" | "neutral",
    { color: string; bg: string }
  > = {
    success: { color: "var(--success-text)", bg: "var(--success-soft)" },
    warning: { color: "var(--warning-text)", bg: "var(--warning-soft)" },
    danger: { color: "var(--danger-text)", bg: "var(--danger-soft)" },
    neutral: { color: "var(--text)", bg: "var(--bg-elev)" },
  };
  const { color, bg } = palette[tone];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 8,
        background: muted ? "transparent" : bg,
        opacity: muted ? 0.45 : 1,
      }}
    >
      <span
        style={{
          fontSize: 13,
          color: muted ? "var(--text-tertiary)" : color,
          fontWeight: 700,
        }}
      >
        {icon}
      </span>
      <span
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: muted ? "var(--text-tertiary)" : color,
          fontFamily: "var(--font-display)",
          lineHeight: 1,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 12,
          color: muted ? "var(--text-tertiary)" : "var(--text-secondary)",
          fontWeight: 500,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function SectionTitle({
  pill,
  tone,
  count,
  label,
  sub,
}: {
  pill: string;
  tone: "success" | "warning" | "danger";
  count: number;
  label: string;
  sub: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span className={`pill pill-${tone}`}>{pill}</span>
        <span
          style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}
        >
          {count} {label}
          {count !== 1 ? "s" : ""}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
        {sub}
      </p>
    </div>
  );
}

function MatchedEmployeeCard({
  group,
  deselected,
  onToggleDeselect,
  onSetGroupDeselected,
  onUndoRemap,
}: {
  group: EmployeeGroup;
  deselected: Set<string>;
  onToggleDeselect: (filename: string) => void;
  onSetGroupDeselected: (filenames: string[], remove: boolean) => void;
  onUndoRemap: (filename: string, parsedCode: string) => void;
}) {
  const emp = group.employee!;
  const avatarText = initials(emp.full_name);
  const selected = group.files.filter((pf) => !deselected.has(pf.file.name));
  const removed = group.files.length - selected.length;
  const allRemoved = selected.length === 0;
  const filenames = group.files.map((pf) => pf.file.name);

  return (
    <div
      className="card"
      style={{
        borderInlineStart: `3px solid ${
          allRemoved ? "var(--border-strong)" : "var(--success)"
        }`,
        opacity: allRemoved ? 0.7 : 1,
        transition: "opacity .15s",
      }}
    >
      <div className="card-head" style={{ padding: "10px 14px" }}>
        <div className="row-person" style={{ minWidth: 0 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "var(--accent-soft)",
              color: "var(--accent-text)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              flexShrink: 0,
            }}
          >
            {avatarText}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="row-person-name">{emp.full_name}</div>
            <div className="row-person-meta">
              {emp.employee_code} · {emp.department.name}
            </div>
          </div>
        </div>
        <span
          className={`pill ${emp.status === "active" ? "pill-success" : "pill-warning"}`}
          style={{ flexShrink: 0, fontSize: 10 }}
        >
          {emp.status}
        </span>
      </div>

      <div className="card-body">
        {/* Per-card summary row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            fontSize: 12,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              color: allRemoved
                ? "var(--text-tertiary)"
                : "var(--success-text)",
              fontWeight: 600,
            }}
          >
            ✓ {selected.length} selected
          </span>
          {removed > 0 && (
            <span style={{ color: "var(--text-tertiary)" }}>
              · ⊘ {removed} removed
            </span>
          )}
          <div
            style={{
              marginInlineStart: "auto",
              display: "flex",
              gap: 4,
            }}
          >
            {removed > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onSetGroupDeselected(filenames, false)}
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                Restore all
              </button>
            )}
            {selected.length > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onSetGroupDeselected(filenames, true)}
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                Remove all
              </button>
            )}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
            gap: 10,
          }}
        >
          {group.files.map((pf) => {
            // A file is "remapped" when the operator forced its lookup
            // code to differ from the one parsed out of its filename.
            // We surface this so they can see it landed on a code they
            // typed by hand, and offer Undo to send it back to the
            // Needs-review section.
            const remappedFrom =
              pf.parsedCode !== null && pf.parsedCode !== group.code
                ? pf.parsedCode
                : null;
            return (
              <ReviewPhotoThumb
                key={pf.file.name}
                pf={pf}
                isSelected={!deselected.has(pf.file.name)}
                onToggle={() => onToggleDeselect(pf.file.name)}
                remappedFrom={remappedFrom}
                onUndoRemap={
                  remappedFrom
                    ? () => onUndoRemap(pf.file.name, remappedFrom)
                    : null
                }
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReviewPhotoThumb({
  pf,
  isSelected,
  onToggle,
  remappedFrom,
  onUndoRemap,
}: {
  pf: ParsedFile;
  isSelected: boolean;
  onToggle: () => void;
  remappedFrom: string | null;
  onUndoRemap: (() => void) | null;
}) {
  return (
    <div style={{ width: "100%" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={isSelected}
        aria-label={`${isSelected ? "Remove" : "Restore"} ${pf.file.name}`}
        style={{
          position: "relative",
          padding: 0,
          width: "100%",
          aspectRatio: "1",
          borderRadius: 10,
          overflow: "hidden",
          border: isSelected
            ? "2px solid var(--success)"
            : "2px dashed var(--border-strong)",
          background: "var(--bg-sunken)",
          cursor: "pointer",
          display: "block",
          transition: "border-color .15s",
        }}
      >
        <img
          src={pf.previewUrl}
          alt={pf.file.name}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: isSelected ? 1 : 0.35,
            filter: isSelected ? "none" : "grayscale(1)",
            transition: "opacity .15s, filter .15s",
            display: "block",
          }}
        />
        {/* Remapped badge — top-start */}
        {remappedFrom && (
          <div
            title={`Remapped from ${remappedFrom}`}
            aria-label={`Remapped from ${remappedFrom}`}
            style={{
              position: "absolute",
              top: 6,
              insetInlineStart: 6,
              minWidth: 22,
              height: 22,
              padding: "0 7px",
              borderRadius: 11,
              background: "var(--warning)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              boxShadow: "var(--shadow-sm)",
              lineHeight: 1,
              gap: 3,
            }}
          >
            <span aria-hidden="true">↻</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
              {remappedFrom}
            </span>
          </div>
        )}
        {/* Selected ✓ / removed × badge — top-end */}
        <div
          style={{
            position: "absolute",
            top: 6,
            insetInlineEnd: 6,
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: isSelected ? "var(--success)" : "var(--bg)",
            border: isSelected ? "none" : "1.5px solid var(--border-strong)",
            color: isSelected ? "#fff" : "var(--text-tertiary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 700,
            boxShadow: "var(--shadow-sm)",
            lineHeight: 1,
          }}
        >
          {isSelected ? "✓" : "×"}
        </div>
        {!isSelected && (
          <div
            style={{
              position: "absolute",
              insetInlineStart: 0,
              insetInlineEnd: 0,
              bottom: 0,
              background: "rgba(0,0,0,.6)",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              textAlign: "center",
              padding: "3px 0",
              letterSpacing: ".06em",
              textTransform: "uppercase",
            }}
          >
            Removed
          </div>
        )}
        {pf.parsedAngle && isSelected && (
          <div
            style={{
              position: "absolute",
              bottom: 6,
              insetInlineStart: 6,
            }}
          >
            <AnglePill angle={pf.parsedAngle} />
          </div>
        )}
      </button>
      <p
        title={pf.file.name}
        style={{
          margin: "5px 0 0",
          fontSize: 10,
          color: "var(--text-tertiary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {pf.file.name}
      </p>
      {remappedFrom && onUndoRemap && (
        <button
          type="button"
          onClick={onUndoRemap}
          aria-label={`Undo remap, send back to needs-review (was ${remappedFrom})`}
          title="Undo remap — sends this photo back to Needs review"
          style={{
            marginTop: 3,
            background: "transparent",
            border: "none",
            padding: "1px 0",
            color: "var(--warning-text)",
            fontSize: 10,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontWeight: 600,
          }}
        >
          <span aria-hidden="true">↻</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>
            was {remappedFrom}
          </span>
          <span style={{ textDecoration: "underline" }}>· undo</span>
        </button>
      )}
    </div>
  );
}

function UnmatchedCard({
  group,
  remaps,
  employeeMap,
  onApplyRemap,
}: {
  group: EmployeeGroup;
  remaps: Map<string, string>;
  employeeMap: Map<string, Employee>;
  onApplyRemap: (filename: string, newCode: string) => void;
}) {
  const existingRemap = remaps.get(group.files[0]?.file.name ?? "") ?? "";
  const [val, setVal] = useState(existingRemap || group.code);

  const upper = val.trim().toUpperCase();
  const matchedEmployee = upper ? (employeeMap.get(upper) ?? null) : null;
  const isEmpty = !upper;
  const noChange = isEmpty || upper === group.code;
  // Apply is gated on an actual employee match — we won't let the
  // operator forward a typo to the backend (which would just reject
  // it again and pollute the audit log).
  const canApply = !noChange && matchedEmployee !== null;

  const apply = () => {
    if (!canApply) return;
    for (const pf of group.files) onApplyRemap(pf.file.name, upper);
  };

  // Inline validation status — shown beneath the input.
  let status: { tone: "success" | "danger" | "muted"; text: string } | null = null;
  if (!isEmpty && !noChange) {
    status = matchedEmployee
      ? {
          tone: "success",
          text: `✓ ${matchedEmployee.full_name} · ${matchedEmployee.department.name}`,
        }
      : {
          tone: "danger",
          text: `✗ No employee found with code "${upper}"`,
        };
  } else if (noChange && !isEmpty) {
    status = { tone: "muted", text: "Enter a different code to remap" };
  }

  return (
    <div
      className="card"
      style={{ borderInlineStart: "3px solid var(--warning)" }}
    >
      <div className="card-head" style={{ padding: "10px 14px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "var(--warning-soft)",
              color: "var(--warning-text)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            ⚠
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text)",
              }}
            >
              Code not found
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-tertiary)",
                fontFamily: "var(--font-mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {group.code} · {group.files.length} file
              {group.files.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      </div>

      <div className="card-body">
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          {group.files.map((pf) => (
            <div
              key={pf.file.name}
              title={pf.file.name}
              style={{
                width: 52,
                height: 52,
                borderRadius: 7,
                overflow: "hidden",
                border: "1px solid var(--border)",
                background: "var(--bg-sunken)",
                flexShrink: 0,
              }}
            >
              <img
                src={pf.previewUrl}
                alt={pf.file.name}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                }}
              />
            </div>
          ))}
        </div>

        <label
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-secondary)",
            marginBottom: 5,
            textTransform: "uppercase",
            letterSpacing: ".04em",
          }}
        >
          Remap to employee code
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            value={val}
            onChange={(e) => setVal(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && apply()}
            placeholder="Enter correct code"
            aria-label={`Correct employee code for ${group.code}`}
            aria-invalid={
              !isEmpty && !noChange && matchedEmployee === null
            }
            style={{
              flex: 1,
              minWidth: 0,
              padding: "6px 10px",
              border:
                !isEmpty && !noChange
                  ? matchedEmployee
                    ? "1px solid var(--success)"
                    : "1px solid var(--danger)"
                  : "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              background: "var(--bg-sunken)",
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button
            className="btn btn-sm"
            onClick={apply}
            disabled={!canApply}
            title={
              canApply
                ? "Apply remap"
                : noChange
                  ? "Enter a different code"
                  : "No employee with that code — fix it before applying"
            }
          >
            Apply
          </button>
        </div>
        {status && (
          <p
            role={status.tone === "danger" ? "alert" : undefined}
            style={{
              margin: "6px 0 0",
              fontSize: 11,
              fontWeight: 500,
              color:
                status.tone === "success"
                  ? "var(--success-text)"
                  : status.tone === "danger"
                    ? "var(--danger-text)"
                    : "var(--text-tertiary)",
            }}
          >
            {status.text}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Phase 3: Results ─────────────────────────────────────────────────────────

function ResultsPhase({
  result,
  employeeMap,
  onReset,
}: {
  result: PhotoIngestResult;
  employeeMap: Map<string, Employee>;
  onReset: () => void;
}) {
  const [tab, setTab] = useState<"accepted" | "rejected">(
    result.accepted.length > 0 ? "accepted" : "rejected",
  );
  const allOk = result.rejected.length === 0 && result.accepted.length > 0;
  const allFail = result.accepted.length === 0;
  const hasRejected = result.rejected.length > 0;

  // Unique uploaded employees, in first-seen order. We resolve back
  // to the loaded Employee record so we can show the human name +
  // link straight to ``/employees?employee=<id>``. The map key is
  // uppercased (employeeMap is built upper-keyed at the page level)
  // so case mismatches between filename + DB don't break lookups.
  const uploadedEmployees = useMemo(() => {
    const seen = new Set<string>();
    const out: { code: string; employee: Employee | null; count: number }[] =
      [];
    const counts = new Map<string, number>();
    for (const row of result.accepted) {
      counts.set(row.employee_code, (counts.get(row.employee_code) ?? 0) + 1);
    }
    for (const row of result.accepted) {
      const key = row.employee_code;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        code: key,
        employee: employeeMap.get(key.toUpperCase()) ?? null,
        count: counts.get(key) ?? 0,
      });
    }
    return out;
  }, [result.accepted, employeeMap]);

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      {/* Stats */}
      <div className="grid grid-2" style={{ gap: 14, marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-label">Photos uploaded</div>
          <div
            className="stat-value"
            style={{
              color:
                result.accepted.length > 0 ? "var(--success-text)" : "var(--text)",
            }}
          >
            {result.accepted.length}
          </div>
          {result.accepted.length > 0 && (
            <div className="stat-delta delta-up">
              <span className="pill pill-success">Success</span>
            </div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">Rejected</div>
          <div
            className="stat-value"
            style={{
              color: hasRejected ? "var(--danger-text)" : "var(--text)",
            }}
          >
            {result.rejected.length}
          </div>
          {hasRejected && (
            <div className="stat-delta delta-down">
              <span className="pill pill-danger">Failed</span>
            </div>
          )}
        </div>
      </div>

      {/* Notice banner */}
      <div
        role="status"
        style={{
          padding: "14px 18px",
          borderRadius: 10,
          background: allOk
            ? "var(--success-soft)"
            : allFail
              ? "var(--danger-soft)"
              : "var(--warning-soft)",
          color: allOk
            ? "var(--success-text)"
            : allFail
              ? "var(--danger-text)"
              : "var(--warning-text)",
          marginBottom: 22,
          fontSize: 13,
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span style={{ fontSize: 16 }}>
          {allOk ? "✓" : allFail ? "✗" : "⚠"}
        </span>
        {allOk &&
          `All ${result.accepted.length} photo${result.accepted.length !== 1 ? "s" : ""} uploaded successfully.`}
        {!allOk &&
          !allFail &&
          `${result.accepted.length} photo${result.accepted.length !== 1 ? "s" : ""} uploaded; ${result.rejected.length} rejected — see the Rejected tab for details.`}
        {allFail &&
          "No photos were accepted. Check the Rejected tab for reasons."}
      </div>

      {/* Uploaded-employees quick links */}
      {uploadedEmployees.length > 0 && (
        <div className="card" style={{ marginBottom: 22 }}>
          <div className="card-head" style={{ padding: "10px 14px" }}>
            <p className="card-title">
              View uploaded employees ({uploadedEmployees.length})
            </p>
            <span
              style={{ fontSize: 11, color: "var(--text-tertiary)" }}
            >
              Click to open the profile and verify reference photos
            </span>
          </div>
          <div className="card-body">
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              {uploadedEmployees.map((u) => {
                const inner = (
                  <>
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: "50%",
                        background: "var(--accent-soft)",
                        color: "var(--accent-text)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                        flexShrink: 0,
                      }}
                    >
                      {u.employee ? initials(u.employee.full_name) : "??"}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        minWidth: 0,
                        lineHeight: 1.2,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: "var(--text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 180,
                        }}
                      >
                        {u.employee?.full_name ?? u.code}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: "var(--text-tertiary)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {u.code} · {u.count} photo{u.count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </>
                );
                const baseStyle: React.CSSProperties = {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 12px 5px 5px",
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: "var(--bg-elev)",
                  color: "var(--text)",
                  textDecoration: "none",
                  transition: "border-color .15s, background .15s",
                };
                return u.employee ? (
                  <Link
                    key={u.code}
                    to={`/employees?employee=${u.employee.id}`}
                    style={baseStyle}
                    aria-label={`View ${u.employee.full_name}'s profile`}
                    title={`Open ${u.employee.full_name} profile`}
                  >
                    {inner}
                    <Icon name="chevronRight" size={11} />
                  </Link>
                ) : (
                  <span
                    key={u.code}
                    style={{
                      ...baseStyle,
                      opacity: 0.6,
                      cursor: "default",
                    }}
                    title="Employee record not in current page cache"
                  >
                    {inner}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Tabs + table */}
      <div className="tabs">
        <button
          className={`tab${tab === "accepted" ? " active" : ""}`}
          onClick={() => setTab("accepted")}
          aria-selected={tab === "accepted"}
        >
          Accepted ({result.accepted.length})
        </button>
        <button
          className={`tab${tab === "rejected" ? " active" : ""}`}
          onClick={() => setTab("rejected")}
          aria-selected={tab === "rejected"}
          style={hasRejected ? { color: "var(--danger-text)" } : undefined}
        >
          Rejected ({result.rejected.length})
        </button>
      </div>

      <div className="card">
        {tab === "accepted" ? (
          result.accepted.length === 0 ? (
            <div className="empty">No photos were accepted.</div>
          ) : (
            <div className="card-body" style={{ padding: 0 }}>
              <table className="table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Employee</th>
                    <th>Angle</th>
                    <th>Photo ID</th>
                    <th style={{ width: 1 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {result.accepted.map((a) => {
                    const emp =
                      employeeMap.get(a.employee_code.toUpperCase()) ?? null;
                    return (
                      <tr key={a.photo_id}>
                        <td>
                          <code
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 12,
                            }}
                          >
                            {a.filename}
                          </code>
                        </td>
                        <td>
                          {emp ? (
                            <Link
                              to={`/employees?employee=${emp.id}`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                color: "var(--text)",
                                textDecoration: "none",
                                fontWeight: 500,
                                fontSize: 13,
                              }}
                              title={`Open ${emp.full_name} profile`}
                            >
                              <span>{emp.full_name}</span>
                              <span
                                style={{
                                  color: "var(--text-tertiary)",
                                  fontFamily: "var(--font-mono)",
                                  fontSize: 11,
                                }}
                              >
                                {a.employee_code}
                              </span>
                            </Link>
                          ) : (
                            <span className="pill pill-success">
                              {a.employee_code}
                            </span>
                          )}
                        </td>
                        <td>
                          <AnglePill angle={a.angle} />
                        </td>
                        <td
                          style={{
                            color: "var(--text-tertiary)",
                            fontSize: 12,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          #{a.photo_id}
                        </td>
                        <td>
                          {emp ? (
                            <Link
                              to={`/employees?employee=${emp.id}`}
                              className="btn btn-ghost btn-sm"
                              aria-label={`View ${emp.full_name} profile`}
                              title="Open employee profile"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: 11,
                                padding: "3px 9px",
                                textDecoration: "none",
                              }}
                            >
                              View
                              <Icon name="chevronRight" size={10} />
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : result.rejected.length === 0 ? (
          <div className="empty">No rejections — all photos were accepted!</div>
        ) : (
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {result.rejected.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {r.filename}
                      </code>
                    </td>
                    <td style={{ color: "var(--danger-text)", fontSize: 12 }}>
                      {r.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CTA buttons */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 10,
          marginTop: 28,
          flexWrap: "wrap",
        }}
      >
        <button className="btn btn-primary" onClick={onReset}>
          Upload More Photos
        </button>
        {uploadedEmployees.length === 1 && uploadedEmployees[0]?.employee ? (
          <Link
            to={`/employees?employee=${uploadedEmployees[0].employee.id}`}
            className="btn"
            style={{ textDecoration: "none" }}
          >
            View {uploadedEmployees[0].employee.full_name}
          </Link>
        ) : (
          <Link to="/employees" className="btn" style={{ textDecoration: "none" }}>
            Back to Employees
          </Link>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const STEPS = [
  { key: "upload" as const, label: "Select", sub: "Choose files" },
  { key: "review" as const, label: "Review", sub: "Map to employees" },
  { key: "results" as const, label: "Done", sub: "Upload complete" },
];

export function BulkPhotoUploadPage() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [rawFiles, setRawFiles] = useState<File[]>([]);
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [remaps, setRemaps] = useState<Map<string, string>>(new Map());
  // Filenames the user explicitly removed during review. Excluded from
  // the upload payload and rendered dimmed/dashed in the grid. Keyed on
  // filename so a remap doesn't drop the user's intent.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<PhotoIngestResult | null>(null);
  const [fetchEmployees, setFetchEmployees] = useState(false);

  const empQuery = useQuery({
    queryKey: ["employees", "bulk-upload-all"],
    queryFn: fetchAllEmployees,
    enabled: fetchEmployees,
    staleTime: 30 * 1000,
  });
  const upload = useBulkIngestPhotos();

  const employeeMap = useMemo(() => {
    const m = new Map<string, Employee>();
    for (const e of empQuery.data ?? []) m.set(e.employee_code.toUpperCase(), e);
    return m;
  }, [empQuery.data]);

  const { groups, parseErrors } = useMemo(() => {
    const byCode = new Map<string, ParsedFile[]>();
    const errors: ParsedFile[] = [];
    for (const pf of parsedFiles) {
      if (pf.parseError !== null) {
        errors.push(pf);
        continue;
      }
      let code = remaps.get(pf.file.name) ?? pf.parsedCode ?? "";

      // Smart auto-resolve. If the parsed code doesn't match any
      // employee but a shorter underscore-separated prefix does
      // (e.g. ``TEST001_SIDE`` → ``TEST001``), use the matching
      // prefix. The original code shows up as a "remapped from"
      // badge via the existing MatchedEmployeeCard logic; the user
      // can click Undo to opt out (which pins an explicit remap
      // back to the original code so the auto-resolve doesn't
      // immediately re-fire). Skipped when the user has already
      // entered an explicit remap, when employees haven't loaded
      // yet, and when the code already matches.
      if (
        !remaps.has(pf.file.name) &&
        code !== "" &&
        employeeMap.size > 0 &&
        !employeeMap.has(code)
      ) {
        const segments = code.split("_");
        while (segments.length > 1) {
          segments.pop();
          const candidate = segments.join("_");
          if (employeeMap.has(candidate)) {
            code = candidate;
            break;
          }
        }
      }

      const list = byCode.get(code) ?? [];
      list.push(pf);
      byCode.set(code, list);
    }
    return {
      groups: Array.from(byCode.entries()).map(([code, files]) => ({
        code,
        employee: employeeMap.get(code) ?? null,
        files,
      })),
      parseErrors: errors,
    };
  }, [parsedFiles, employeeMap, remaps]);

  const handleAdd = useCallback((incoming: File[]) => {
    setRawFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...incoming.filter((f) => !names.has(f.name))];
    });
  }, []);

  const handleRemove = useCallback(
    (name: string) => setRawFiles((prev) => prev.filter((f) => f.name !== name)),
    [],
  );

  const handleReview = useCallback(() => {
    // Revoke any old preview URLs
    for (const pf of parsedFiles) URL.revokeObjectURL(pf.previewUrl);
    const parsed: ParsedFile[] = rawFiles.map((file) => {
      const { code, angle, error } = parseFilename(file.name);
      return {
        file,
        previewUrl: URL.createObjectURL(file),
        parsedCode: code,
        parsedAngle: angle,
        parseError: error,
      };
    });
    setParsedFiles(parsed);
    setFetchEmployees(true);
    setPhase("review");
  }, [rawFiles, parsedFiles]);

  const handleApplyRemap = useCallback((filename: string, newCode: string) => {
    setRemaps((prev) => {
      const next = new Map(prev);
      next.set(filename, newCode.toUpperCase());
      return next;
    });
  }, []);

  const handleUndoRemap = useCallback(
    (filename: string, parsedCode: string) => {
      setRemaps((prev) => {
        const next = new Map(prev);
        if (next.has(filename)) {
          // Explicit remap → clear it. The file goes back to its
          // parsed code; auto-resolve may pick a prefix next render.
          next.delete(filename);
        } else {
          // Auto-resolved (no entry in remaps but file landed in a
          // group != parsedCode). Pin an explicit "no-op" remap to
          // the original parsed code so the auto-resolve stops, and
          // the file shows up in Needs review under that code.
          next.set(filename, parsedCode);
        }
        return next;
      });
    },
    [],
  );

  const handleToggleDeselect = useCallback((filename: string) => {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }, []);

  const handleSetGroupDeselected = useCallback(
    (filenames: string[], remove: boolean) => {
      setDeselected((prev) => {
        const next = new Set(prev);
        for (const fn of filenames) {
          if (remove) next.add(fn);
          else next.delete(fn);
        }
        return next;
      });
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    const filesToUpload: File[] = [];
    for (const pf of parsedFiles) {
      if (pf.parseError !== null) continue;
      if (deselected.has(pf.file.name)) continue;
      // Backend `employee_code` is case-sensitive (Text, not CITEXT) and
      // refuses unknown codes. Skip files that don't match any employee
      // and use the matched employee's stored code so e.g. a filename
      // typed as `Test001_front` lands as `Test001` even though the
      // page normalises to uppercase for client-side matching.
      const lookupCode = remaps.get(pf.file.name) ?? pf.parsedCode!;
      const matched = employeeMap.get(lookupCode.toUpperCase());
      if (!matched) continue;
      const angle = pf.parsedAngle ?? "other";
      const ext = pf.file.name.split(".").pop() ?? "jpg";
      const newName = `${matched.employee_code}_${angle}.${ext}`;
      filesToUpload.push(
        newName !== pf.file.name
          ? new File([pf.file], newName, { type: pf.file.type })
          : pf.file,
      );
    }
    try {
      const res = await upload.mutateAsync(filesToUpload);
      for (const pf of parsedFiles) URL.revokeObjectURL(pf.previewUrl);
      setResult(res);
      setPhase("results");
    } catch {
      /* surfaces via upload.isError */
    }
  }, [parsedFiles, deselected, remaps, upload, employeeMap]);

  const handleBack = useCallback(() => {
    for (const pf of parsedFiles) URL.revokeObjectURL(pf.previewUrl);
    setParsedFiles([]);
    setDeselected(new Set());
    setPhase("upload");
  }, [parsedFiles]);

  const handleReset = useCallback(() => {
    setPhase("upload");
    setRawFiles([]);
    setParsedFiles([]);
    setRemaps(new Map());
    setDeselected(new Set());
    setResult(null);
    setFetchEmployees(false);
    upload.reset();
  }, [upload]);

  const stepIdx = STEPS.findIndex((s) => s.key === phase);

  return (
    <div className="content-wrap">
      {/* ── Page header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Bulk Photo Upload</h1>
          <p className="page-sub">
            Upload employee photos in bulk — auto-mapped from filenames like{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              OM0097_front.jpg
            </code>
          </p>
        </div>
      </div>

      {/* ── Step indicator ── */}
      <div className="chain-mini" style={{ marginBottom: 24 }}>
        {STEPS.map((s, i) => {
          const isDone = stepIdx > i;
          const isActive = stepIdx === i;
          return (
            <Fragment key={s.key}>
              <div
                className={`chain-mini-step${isDone ? " done" : isActive ? " active" : ""}`}
              >
                <div className="cm-dot">{isDone ? "✓" : i + 1}</div>
                <div className="cm-name">{s.label}</div>
                <div className="cm-sub">{s.sub}</div>
              </div>
              {i < STEPS.length - 1 && <div className="cm-bar" />}
            </Fragment>
          );
        })}
      </div>

      {/* ── Upload error banner ── */}
      {upload.isError && (
        <div
          role="alert"
          style={{
            padding: "12px 16px",
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            borderRadius: 8,
            marginBottom: 18,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Upload failed:{" "}
          {upload.error instanceof Error ? upload.error.message : "Unknown error"}
        </div>
      )}

      {/* ── Phase content ── */}
      {phase === "upload" && (
        <UploadPhase
          files={rawFiles}
          onAdd={handleAdd}
          onRemove={handleRemove}
          onClear={() => setRawFiles([])}
          onReview={handleReview}
        />
      )}

      {phase === "review" && (
        <ReviewPhase
          groups={groups}
          parseErrors={parseErrors}
          isLoadingEmployees={empQuery.isLoading}
          remaps={remaps}
          deselected={deselected}
          employeeMap={employeeMap}
          onToggleDeselect={handleToggleDeselect}
          onSetGroupDeselected={handleSetGroupDeselected}
          onApplyRemap={handleApplyRemap}
          onUndoRemap={handleUndoRemap}
          onSubmit={handleSubmit}
          onBack={handleBack}
          isUploading={upload.isPending}
        />
      )}

      {phase === "results" && result !== null && (
        <ResultsPhase
          result={result}
          employeeMap={employeeMap}
          onReset={handleReset}
        />
      )}
    </div>
  );
}
