// Right-sliding drawer the Employee uses to file a new request.
//
// Two-step UX kept on a single screen: pick type (radio) → form swaps
// fields between exception (single date) and leave (date range +
// leave-type dropdown). Reason category is sourced from
// /api/request-reason-categories and filtered to the chosen type.
// Optional attachment uploaded after the parent row is created.

import { useEffect, useMemo, useState } from "react";

import { ApiError } from "../api/client";
import { DatePicker } from "../components/DatePicker";
import { DrawerShell } from "../components/DrawerShell";
import { useLeaveTypes } from "../leave-calendar/hooks";
import { Icon } from "../shell/Icon";
import {
  useAttachmentConfig,
  useCreateRequest,
  useReasonCategories,
  useUploadAttachment,
} from "./hooks";
import type { RequestType } from "./types";

interface Props {
  onClose: () => void;
  onCreated: (requestId: number) => void;
  // P28.6: optional pre-fill so the calendar's day drawer can route
  // straight into "+ Submit exception" with the right type + date.
  initialType?: RequestType;
  initialStartDate?: string;
}

export function NewRequestDrawer({
  onClose,
  onCreated,
  initialType,
  initialStartDate,
}: Props) {
  const [type, setType] = useState<RequestType>(initialType ?? "exception");
  const [reasonCategory, setReasonCategory] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [startDate, setStartDate] = useState(initialStartDate ?? "");
  const [endDate, setEndDate] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState<number | "">("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const categories = useReasonCategories(type);
  const leaveTypes = useLeaveTypes();
  const attachmentConfig = useAttachmentConfig();
  const create = useCreateRequest();
  const upload = useUploadAttachment();

  // Reset reason category when the type flips.
  useEffect(() => {
    setReasonCategory("");
  }, [type]);

  const accepted = useMemo(
    () =>
      attachmentConfig.data?.accepted_mime_types.join(",") ??
      "image/jpeg,image/png,image/gif,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    [attachmentConfig.data],
  );
  const maxMb = attachmentConfig.data?.max_mb ?? 5;

  const validateFile = (file: File): string | null => {
    if (file.size === 0) return "file is empty";
    if (file.size > maxMb * 1024 * 1024) {
      return `file is ${(file.size / 1024 / 1024).toFixed(1)}MB; max is ${maxMb}MB`;
    }
    return null;
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      setPendingFile(null);
      return;
    }
    const err = validateFile(f);
    if (err) {
      setServerError(err);
      e.target.value = "";
      setPendingFile(null);
      return;
    }
    setServerError(null);
    setPendingFile(f);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    const err = validateFile(f);
    if (err) {
      setServerError(err);
      return;
    }
    setServerError(null);
    setPendingFile(f);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (!reasonCategory) {
      setServerError("pick a reason category");
      return;
    }
    if (!startDate) {
      setServerError("pick a start date");
      return;
    }
    if (type === "leave" && !leaveTypeId) {
      setServerError("pick a leave type");
      return;
    }

    try {
      const trimmedText = reasonText.trim();
      const payload: import("./types").RequestCreateInput = {
        type,
        reason_category: reasonCategory,
        target_date_start: startDate,
        target_date_end:
          type === "leave" ? endDate || startDate : null,
        leave_type_id:
          type === "leave" && leaveTypeId !== ""
            ? Number(leaveTypeId)
            : null,
      };
      if (trimmedText) payload.reason_text = trimmedText;
      const created = await create.mutateAsync(payload);
      if (pendingFile) {
        try {
          await upload.mutateAsync({ requestId: created.id, file: pendingFile });
        } catch (uploadErr) {
          // The request itself landed; surface the upload failure but
          // don't roll back. Operator can re-attach from the detail
          // drawer later.
          if (uploadErr instanceof ApiError) {
            setServerError(
              `Request created, but the attachment failed: ${uploadErr.message}`,
            );
          } else {
            setServerError(
              "Request created, but the attachment failed to upload.",
            );
          }
        }
      }
      onCreated(created.id);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setServerError(
          typeof body?.detail === "string"
            ? body.detail
            : `Save failed (${err.status}).`,
        );
      } else {
        setServerError("Save failed.");
      }
    }
  };

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">New request</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              Submit for approval
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        <form onSubmit={submit} style={{ display: "contents" }}>
          <div className="drawer-body">
            {/* Type radio */}
            <SectionLabel>Request type</SectionLabel>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {(["exception", "leave"] as RequestType[]).map((t) => (
                <label
                  key={t}
                  className={`pill ${type === t ? "pill-accent" : "pill-neutral"}`}
                  style={{ cursor: "pointer", textTransform: "capitalize" }}
                >
                  <input
                    type="radio"
                    name="type"
                    value={t}
                    checked={type === t}
                    onChange={() => setType(t)}
                    style={{ display: "none" }}
                  />
                  {t}
                </label>
              ))}
            </div>

            <SectionLabel>Reason category</SectionLabel>
            <select
              className="input"
              value={reasonCategory}
              onChange={(e) => setReasonCategory(e.target.value)}
              style={{ marginBottom: 12 }}
            >
              <option value="">— Select —</option>
              {categories.data
                ?.filter((c) => c.active)
                .map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.name}
                  </option>
                ))}
            </select>

            <SectionLabel>
              {type === "exception" ? "Target date" : "Date range"}
            </SectionLabel>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  type === "exception" ? "1fr" : "1fr 1fr",
                gap: 8,
                marginBottom: 12,
              }}
            >
              <DatePicker
                value={startDate}
                onChange={setStartDate}
                ariaLabel={type === "exception" ? "Target date" : "Start date"}
                triggerStyle={{ width: "100%" }}
              />
              {type === "leave" && (
                <DatePicker
                  value={endDate}
                  onChange={setEndDate}
                  min={startDate}
                  ariaLabel="End date"
                  triggerStyle={{ width: "100%" }}
                />
              )}
            </div>

            {type === "leave" && (
              <>
                <SectionLabel>Leave type</SectionLabel>
                <select
                  className="input"
                  value={leaveTypeId}
                  onChange={(e) =>
                    setLeaveTypeId(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                  style={{ marginBottom: 12 }}
                >
                  <option value="">— Select —</option>
                  {leaveTypes.data
                    ?.filter((lt) => lt.active)
                    .map((lt) => (
                      <option key={lt.id} value={lt.id}>
                        {lt.name}
                      </option>
                    ))}
                </select>
              </>
            )}

            <SectionLabel>Notes (optional)</SectionLabel>
            <textarea
              className="input"
              rows={3}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              style={{ marginBottom: 14, resize: "vertical" }}
            />

            <SectionLabel>Attachment (optional)</SectionLabel>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              style={{
                border: "1px dashed var(--border-strong)",
                background: "var(--bg-sunken)",
                borderRadius: "var(--radius)",
                padding: 16,
                textAlign: "center",
                fontSize: 12.5,
                color: "var(--text-secondary)",
                marginBottom: 6,
              }}
            >
              <Icon name="upload" size={16} />{" "}
              {pendingFile ? (
                <>
                  <span className="mono">{pendingFile.name}</span> —{" "}
                  {(pendingFile.size / 1024).toFixed(0)} KB
                </>
              ) : (
                <>
                  Drop a file here, or{" "}
                  <label
                    style={{
                      textDecoration: "underline",
                      cursor: "pointer",
                      color: "var(--text)",
                    }}
                  >
                    choose
                    <input
                      type="file"
                      accept={accepted}
                      onChange={onPickFile}
                      style={{ display: "none" }}
                    />
                  </label>
                </>
              )}
              <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                Max {maxMb}MB · images, PDF, DOCX
              </div>
            </div>

            {serverError && (
              <div
                role="alert"
                style={{
                  background: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  border: "1px solid var(--border)",
                  padding: "8px 10px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12.5,
                  marginTop: 8,
                }}
              >
                {serverError}
              </div>
            )}
          </div>
          <div className="drawer-foot">
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={create.isPending || upload.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={create.isPending || upload.isPending}
            >
              {create.isPending || upload.isPending
                ? "Submitting…"
                : "Submit request"}
            </button>
          </div>
        </form>
      </div>
    </DrawerShell>
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
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}
