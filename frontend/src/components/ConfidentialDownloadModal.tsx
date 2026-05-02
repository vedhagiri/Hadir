// Gates every report download (XLSX / PDF / CSV) with a one-time
// confidentiality warning. The operator must tick the acknowledgement
// checkbox before the Download button enables — the policy red line is
// that the file is org-internal and must not leave approved systems
// (PDPL / data-protection policy).
//
// Mounted indirectly via ``useConfidentialDownload`` so each report
// page just calls ``gate(action, info)`` and renders ``modal`` once.

import { useEffect, useRef, useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  // Human-readable name of what's about to be downloaded.
  // E.g. "Attendance — 2026-04-29 → 2026-05-02" or "Event log — 2026-05-02".
  reportName: string;
  format: "xlsx" | "pdf" | "csv";
  busy?: boolean;
}

const FORMAT_LABEL: Record<Props["format"], string> = {
  xlsx: "Excel workbook (.xlsx)",
  pdf: "PDF document (.pdf)",
  csv: "CSV file (.csv)",
};

export function ConfidentialDownloadModal({
  open,
  onClose,
  onConfirm,
  reportName,
  format,
  busy = false,
}: Props) {
  const [acked, setAcked] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Reset the checkbox each time the modal opens — last-used state
  // would defeat the purpose of an explicit acknowledgement.
  useEffect(() => {
    if (open) setAcked(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, busy]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confidential download"
      onMouseDown={(e) => {
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
          width: "min(520px, 94vw)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              width: 36,
              height: 36,
              flexShrink: 0,
              borderRadius: 8,
              background: "var(--warning-soft, rgba(234, 179, 8, 0.15))",
              color: "var(--warning-text, #b45309)",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              lineHeight: 1,
            }}
          >
            ⚠
          </span>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
              Confidential — handle with care
            </h2>
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 12.5,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
              }}
            >
              This report contains personal and operational data covered by
              your organisation&apos;s data-protection policy and applicable
              privacy law (PDPL / equivalent). Sharing it outside the
              organisation may constitute a violation.
            </p>
          </div>
        </div>

        <ul
          style={{
            margin: 0,
            padding: "12px 14px 12px 30px",
            background: "var(--warning-soft, rgba(234, 179, 8, 0.08))",
            border: "1px solid var(--warning, rgba(234, 179, 8, 0.3))",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <li>Store the file on approved company systems only.</li>
          <li>
            Do not forward, attach to personal email, or upload to public
            cloud / messaging services.
          </li>
          <li>
            Share with internal recipients on a need-to-know basis; delete
            local copies once no longer needed.
          </li>
        </ul>

        <div
          style={{
            padding: "10px 12px",
            background: "var(--bg-sunken)",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            About to download
          </span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{reportName}</span>
          <span
            className="mono text-xs"
            style={{ color: "var(--text-tertiary)" }}
          >
            {FORMAT_LABEL[format]}
          </span>
        </div>

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: 10,
            cursor: busy ? "wait" : "pointer",
            fontSize: 12.5,
            color: "var(--text)",
            lineHeight: 1.5,
          }}
        >
          <input
            type="checkbox"
            checked={acked}
            disabled={busy}
            onChange={(e) => setAcked(e.target.checked)}
            style={{ marginTop: 2, accentColor: "var(--accent)" }}
          />
          <span>
            I acknowledge this file is confidential and I will not share it
            outside the organisation.
          </span>
        </label>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
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
            onClick={onConfirm}
            disabled={!acked || busy}
            title={
              !acked
                ? "Tick the acknowledgement to enable download"
                : undefined
            }
          >
            {busy ? "Downloading…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  );
}
