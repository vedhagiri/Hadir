// Excel import modal — drag-and-drop or file picker, shows per-row results
// and stays open until the user explicitly acknowledges.

import { useCallback, useState } from "react";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { useImportEmployees } from "./hooks";
import type { ImportResult } from "./types";

interface Props {
  onClose: () => void;
}

export function ImportModal({ onClose }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const importMutation = useImportEmployees();

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }, []);

  const run = async () => {
    if (!file) return;
    try {
      const r = await importMutation.mutateAsync(file);
      setResult(r);
    } catch {
      // Mutation state surfaces the error below.
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          // Background painted by the ModalShell's scrim — keep this
          // wrapper transparent so the two don't double-up.
          zIndex: 60,
          display: "grid",
          placeItems: "center",
        }}
        // Backdrop is presentation-only — close via Cancel/Done.
        // Operator-policy red line; see DrawerShell.
      >
        <div
          className="card"
          style={{
            width: "min(560px, 92vw)",
            maxHeight: "80vh",
            overflow: "auto",
          }}
        >
          <div className="card-head">
            <div>
              <h3 className="card-title">Import employees</h3>
              <p className="card-sub">
                Required columns: <span className="mono">employee_code</span>,
                <span className="mono"> full_name</span>,
                <span className="mono"> email</span>,
                <span className="mono"> department_code</span>.
                {" "}Optional P28.7 columns:{" "}
                <span className="mono">designation</span>,{" "}
                <span className="mono">phone</span>,{" "}
                <span className="mono">reports_to_email</span>,{" "}
                <span className="mono">joining_date</span>,{" "}
                <span className="mono">relieving_date</span>.
                {" "}Bulk delete is not supported — use the per-row
                Delete on the employees page.
              </p>
            </div>
            <button
              className="icon-btn"
              onClick={onClose}
              disabled={importMutation.isPending}
              title="Close"
              aria-label="Close"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!result && (
              <>
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
                    padding: 24,
                    textAlign: "center",
                    fontSize: 13,
                    color: "var(--text-secondary)",
                  }}
                >
                  <div style={{ marginBottom: 8 }}>
                    <Icon name="upload" size={20} />
                  </div>
                  <div>
                    Drop an .xlsx or .csv here, or{" "}
                    <label
                      style={{
                        textDecoration: "underline",
                        cursor: "pointer",
                        color: "var(--text)",
                      }}
                    >
                      choose a file
                      <input
                        type="file"
                        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv"
                        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                        style={{ display: "none" }}
                      />
                    </label>
                  </div>
                  {file && (
                    <div
                      className="mono text-sm"
                      style={{ marginTop: 10, color: "var(--text)" }}
                    >
                      {file.name} · {Math.round(file.size / 1024)} KB
                    </div>
                  )}
                </div>

                {importMutation.error && (
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
                    Import failed. Check the file and try again.
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button className="btn" onClick={onClose} disabled={importMutation.isPending}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={run}
                    disabled={!file || importMutation.isPending}
                  >
                    <Icon name="upload" size={12} />
                    {importMutation.isPending ? "Uploading…" : "Import"}
                  </button>
                </div>
              </>
            )}

            {result && (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <span className="pill pill-success">created {result.created}</span>
                  <span className="pill pill-info">updated {result.updated}</span>
                  <span className={`pill ${result.errors.length > 0 ? "pill-warning" : "pill-neutral"}`}>
                    errors {result.errors.length}
                  </span>
                </div>
                {result.errors.length > 0 && (
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        fontWeight: 500,
                        color: "var(--text-tertiary)",
                        margin: "6px 0",
                      }}
                    >
                      Row-level errors
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 80 }}>Row</th>
                          <th>Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.errors.map((e) => (
                          <tr key={e.row}>
                            <td className="mono text-sm">{e.row}</td>
                            <td className="text-sm">{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary" onClick={onClose}>
                    <Icon name="check" size={12} />
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
