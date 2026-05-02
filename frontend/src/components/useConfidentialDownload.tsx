// Hook that wraps every report download in a confidentiality gate.
//
// Usage:
//   const { gate, modal } = useConfidentialDownload();
//   ...
//   <button onClick={() => gate({
//     action: () => doDownload(),
//     reportName: "Attendance — 2026-04-29 → 2026-05-02",
//     format: "xlsx",
//   })}>Download</button>
//   ...
//   {modal}
//
// The gate opens ``ConfidentialDownloadModal``; on confirm it awaits
// the supplied ``action`` (with a busy state on the modal so the user
// can't double-click) and closes the modal afterwards. Cancel just
// closes — the action never runs.

import { useCallback, useState } from "react";

import { ConfidentialDownloadModal } from "./ConfidentialDownloadModal";

export type DownloadFormat = "xlsx" | "pdf" | "csv";

export interface ConfidentialDownloadRequest {
  /** The actual download work — fetch + blob save, or open a follow-up
   *  modal (e.g. PdfOptionsModal). May be sync or async. */
  action: () => void | Promise<void>;
  /** Human-readable summary of the file the operator is about to get. */
  reportName: string;
  format: DownloadFormat;
}

export function useConfidentialDownload(): {
  gate: (req: ConfidentialDownloadRequest) => void;
  modal: JSX.Element | null;
} {
  const [pending, setPending] = useState<ConfidentialDownloadRequest | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const gate = useCallback((req: ConfidentialDownloadRequest) => {
    setPending(req);
  }, []);

  const onClose = useCallback(() => {
    if (!busy) setPending(null);
  }, [busy]);

  const onConfirm = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await pending.action();
    } finally {
      setBusy(false);
      setPending(null);
    }
  }, [pending]);

  const modal = pending ? (
    <ConfidentialDownloadModal
      open={true}
      onClose={onClose}
      onConfirm={onConfirm}
      reportName={pending.reportName}
      format={pending.format}
      busy={busy}
    />
  ) : null;

  return { gate, modal };
}
