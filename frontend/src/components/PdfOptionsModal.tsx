// Modal that gates every PDF report download. Asks one question —
// "Include employee photos?" — and on Generate fires a callback with
// the chosen flag. Cancel just closes.
//
// Mounted by every PDF entry point: DailyAttendancePage,
// ReportsPage, EmployeeReportPage. Backend honours the flag via
// AttendanceReportRequest.include_employee_photos (router.py P17 +
// follow-up).

import { useEffect, useRef, useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (includePhotos: boolean) => void;
  busy?: boolean;
}

export function PdfOptionsModal({ open, onClose, onConfirm, busy = false }: Props) {
  const [includePhotos, setIncludePhotos] = useState(true);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Reset to default each time the modal opens — last-used state
  // would be a footgun if the operator forgot they'd unticked it
  // for a previous report.
  useEffect(() => {
    if (open) setIncludePhotos(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="PDF options"
      onMouseDown={(e) => {
        // Click on the overlay (not inside the dialog) closes.
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 1000,
      }}
    >
      <div
        ref={dialogRef}
        style={{
          background: "var(--bg-elev)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          padding: 22,
          width: "min(420px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
            Generate PDF report
          </h2>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 12.5,
              color: "var(--text-secondary)",
            }}
          >
            Pick the options for this PDF before downloading.
          </p>
        </div>

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: 12,
            background: "var(--bg-sunken)",
            borderRadius: "var(--radius-sm)",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={includePhotos}
            disabled={busy}
            onChange={(e) => setIncludePhotos(e.target.checked)}
            style={{ marginTop: 2, accentColor: "var(--accent)" }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>
              Include employee photos
            </span>
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              Adds the In / Out face crop columns from the camera events.
              Slower to render and a larger file; uncheck for a leaner
              report.
            </span>
          </div>
        </label>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => onConfirm(includePhotos)}
            disabled={busy}
          >
            {busy ? "Generating…" : "Generate PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
