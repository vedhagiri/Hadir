// Right-sliding drawer the Employee uses to file a new request.
//
// Two-step UX kept on a single screen: pick type (choice cards) →
// form swaps fields between exception (single date) and leave (date
// range + leave-type dropdown). Reason category is sourced from
// /api/request-reason-categories and filtered to the chosen type.
// Optional attachment uploaded after the parent row is created.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { DatePicker } from "../components/DatePicker";
import { DrawerShell } from "../components/DrawerShell";
import { ChoiceCards, Field, FormFooter, FormHeader, FormNotice, FormSection } from "../components/FormKit";
import { useLeaveTypes } from "../leave-calendar/hooks";
import { Icon } from "../shell/Icon";
import {
  useAttachmentConfig,
  useCreateRequest,
  useReasonCategories,
  useUploadAttachment,
} from "./hooks";
import type { RequestType } from "./types";
import { errorDetail } from "./workflowUi";

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
  const { t } = useTranslation();
  const [type, setType] = useState<RequestType>(initialType ?? "exception");
  const [reasonCategory, setReasonCategory] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [startDate, setStartDate] = useState(initialStartDate ?? "");
  const [endDate, setEndDate] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState<number | "">("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // Per-field validation (shown inline under the field that failed).
  const [errors, setErrors] = useState<{ reason?: string | undefined; start?: string | undefined; leaveType?: string | undefined; file?: string | undefined }>({});
  const clearError = (k: "reason" | "start" | "leaveType" | "file") =>
    setErrors((prev) => (prev[k] ? { ...prev, [k]: undefined } : prev));
  const [dragOver, setDragOver] = useState(false);

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
    if (file.size === 0) return t("newRequest.fileEmpty", { defaultValue: "The file is empty." });
    if (file.size > maxMb * 1024 * 1024) {
      return t("newRequest.fileTooLarge", {
        defaultValue: "File is {{size}}MB; the maximum is {{max}}MB.",
        size: (file.size / 1024 / 1024).toFixed(1),
        max: maxMb,
      });
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
      setErrors((prev) => ({ ...prev, file: err }));
      e.target.value = "";
      setPendingFile(null);
      return;
    }
    clearError("file");
    setPendingFile(f);
  };

  const onDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    const err = validateFile(f);
    if (err) {
      setErrors((prev) => ({ ...prev, file: err }));
      return;
    }
    clearError("file");
    setPendingFile(f);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setServerError(null);

    if (!reasonCategory) {
      setErrors((prev) => ({ ...prev, reason: t("newRequest.pickReason", { defaultValue: "Pick a reason category." }) }));
      return;
    }
    if (!startDate) {
      setErrors((prev) => ({ ...prev, start: t("newRequest.pickStart", { defaultValue: "Pick a start date." }) }));
      return;
    }
    if (type === "leave" && !leaveTypeId) {
      setErrors((prev) => ({ ...prev, leaveType: t("newRequest.pickLeaveType", { defaultValue: "Pick a leave type." }) }));
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
          setServerError(
            t("newRequest.attachmentFailed", {
              defaultValue: "Request created, but the attachment failed: {{reason}}",
              reason:
                uploadErr instanceof ApiError
                  ? uploadErr.message
                  : t("common.errorGeneric"),
            }),
          );
        }
      }
      onCreated(created.id);
      onClose();
    } catch (err) {
      setServerError(
        err instanceof ApiError
          ? errorDetail(err, t("newRequest.saveFailed", { defaultValue: "Save failed" }))
          : t("newRequest.saveFailed", { defaultValue: "Save failed" }),
      );
    }
  };

  const busy = create.isPending || upload.isPending;
  const selectPlaceholder = t("newRequest.selectPlaceholder", { defaultValue: "— Select —" });
  const startLabel =
    type === "exception"
      ? t("newRequest.targetDate", { defaultValue: "Target date" })
      : t("newRequest.startDate", { defaultValue: "Start date" });
  const canSubmit = reasonCategory !== "" && startDate !== "" && (type !== "leave" || leaveTypeId !== "");

  return (
    <DrawerShell onClose={onClose}>
      <form className="drawer fk-drawer" onSubmit={submit}>
        <FormHeader
          icon={<Icon name="send" size={18} />}
          title={t("myRequests.newRequest")}
          subtitle={t("newRequest.formSubtitle", {
            defaultValue: "Ask for leave or explain an attendance exception. It goes to your manager for approval.",
          })}
          onClose={onClose}
        />
        <div className="drawer-body fk-body">
          {serverError && <FormNotice tone="danger">{serverError}</FormNotice>}

          <FormSection
            step={1}
            title={t("newRequest.sectionType", { defaultValue: "Request type" })}
            description={t("newRequest.sectionTypeDesc", { defaultValue: "Pick what you are asking for. The fields below adapt to it." })}
          >
            <ChoiceCards<RequestType>
              label={t("newRequest.sectionType", { defaultValue: "Request type" })}
              value={type}
              onChange={(v) => {
                setType(v);
                setErrors({});
              }}
              options={[
                {
                  value: "exception",
                  title: t("myRequests.filters.exception"),
                  description: t("newRequest.exceptionHelp", { defaultValue: "Explain a late arrival, early departure or missed detection on one day." }),
                  icon: <Icon name="clock" size={16} />,
                },
                {
                  value: "leave",
                  title: t("myRequests.filters.leave"),
                  description: t("newRequest.leaveHelp", { defaultValue: "Time away from work. Needs a date range and a leave type." }),
                  icon: <Icon name="calendar" size={16} />,
                },
              ]}
            />
          </FormSection>

          <FormSection
            step={2}
            title={t("newRequest.sectionWhen", { defaultValue: "When" })}
            description={
              type === "leave"
                ? t("newRequest.sectionWhenLeaveDesc", { defaultValue: "The first and last day you will be away." })
                : t("newRequest.sectionWhenExceptionDesc", { defaultValue: "The day the exception applies to." })
            }
          >
            <Field label={startLabel} required error={errors.start}>
              <DatePicker
                value={startDate}
                onChange={(v) => {
                  setStartDate(v);
                  clearError("start");
                }}
                ariaLabel={startLabel}
                triggerStyle={{ width: "100%" }}
              />
            </Field>
            {type === "leave" && (
              <Field label={t("newRequest.endDate", { defaultValue: "End date" })} help={t("newRequest.endDateHelp", { defaultValue: "Leave blank for a single day." })}>
                <DatePicker
                  value={endDate}
                  onChange={setEndDate}
                  min={startDate}
                  ariaLabel={t("newRequest.endDate", { defaultValue: "End date" })}
                  triggerStyle={{ width: "100%" }}
                />
              </Field>
            )}
          </FormSection>

          <FormSection
            step={3}
            title={t("newRequest.sectionWhy", { defaultValue: "Reason" })}
            description={t("newRequest.sectionWhyDesc", { defaultValue: "Why you need this. Your approver sees the category and your notes." })}
          >
            <Field
              label={t("newRequest.reasonCategory", { defaultValue: "Reason category" })}
              htmlFor="nr-reason"
              required
              error={errors.reason}
              span={type === "leave" ? 1 : 2}
            >
              <select
                id="nr-reason"
                className="select"
                value={reasonCategory}
                onChange={(e) => {
                  setReasonCategory(e.target.value);
                  clearError("reason");
                }}
              >
                <option value="">{selectPlaceholder}</option>
                {categories.data
                  ?.filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
            {type === "leave" && (
              <Field label={t("newRequest.leaveType", { defaultValue: "Leave type" })} htmlFor="nr-leave-type" required error={errors.leaveType}>
                <select
                  id="nr-leave-type"
                  className="select"
                  value={leaveTypeId}
                  onChange={(e) => {
                    setLeaveTypeId(
                      e.target.value === "" ? "" : Number(e.target.value),
                    );
                    clearError("leaveType");
                  }}
                >
                  <option value="">{selectPlaceholder}</option>
                  {leaveTypes.data
                    ?.filter((lt) => lt.active)
                    .map((lt) => (
                      <option key={lt.id} value={lt.id}>
                        {lt.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field
              label={t("newRequest.notes", { defaultValue: "Notes" })}
              htmlFor="nr-notes"
              span={2}
              help={
                <span className="wf-fk-help-row">
                  <span>{t("common.optional")}</span>
                  <span className="wf-fk-counter mono">{reasonText.length} / 1000</span>
                </span>
              }
            >
              <textarea
                id="nr-notes"
                className="textarea"
                rows={3}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                maxLength={1000}
                placeholder={t("newRequest.notesPlaceholder", { defaultValue: "e.g. Doctor's appointment in the morning." })}
              />
            </Field>
          </FormSection>

          <FormSection
            step={4}
            title={t("newRequest.sectionAttachment", { defaultValue: "Attachment" })}
            description={t("newRequest.sectionAttachmentDesc", { defaultValue: "Optional. A doctor's note or other proof helps your approver decide." })}
            columns={1}
          >
            <Field label={t("newRequest.attachmentLabel", { defaultValue: "Supporting document" })} {...(pendingFile ? {} : { htmlFor: "nr-file" })} error={errors.file}>
              {pendingFile ? (
                <div className="wf-fk-file">
                  <span className="wf-fk-file-icon" aria-hidden>
                    <Icon name="fileText" size={16} />
                  </span>
                  <span className="wf-fk-file-text">
                    <span className="wf-fk-file-name mono">{pendingFile.name}</span>
                    <span className="wf-fk-file-meta">{(pendingFile.size / 1024).toFixed(0)} KB</span>
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPendingFile(null)}>
                    {t("newRequest.removeFile", { defaultValue: "Remove" })}
                  </button>
                </div>
              ) : (
                <label
                  htmlFor="nr-file"
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  className={`wf-fk-dropzone${dragOver ? " is-over" : ""}`}
                >
                  <span className="wf-fk-dropzone-icon" aria-hidden>
                    <Icon name="upload" size={16} />
                  </span>
                  <span>
                    {t("newRequest.dropHere", { defaultValue: "Drop a file here, or" })}{" "}
                    <span className="wf-link-btn">{t("newRequest.choose", { defaultValue: "choose a file" })}</span>
                  </span>
                  <span className="wf-fk-dropzone-hint">
                    {t("newRequest.fileHint", { defaultValue: "Max {{max}}MB · images, PDF, DOCX · optional", max: maxMb })}
                  </span>
                  <input id="nr-file" type="file" className="wf-file-input" accept={accepted} onChange={onPickFile} />
                </label>
              )}
            </Field>
          </FormSection>
        </div>
        <FormFooter
          onCancel={onClose}
          submitLabel={t("newRequest.submit", { defaultValue: "Submit request" })}
          submittingLabel={t("newRequest.submitting", { defaultValue: "Submitting…" })}
          submitting={busy}
          canSubmit={canSubmit}
        />
      </form>
    </DrawerShell>
  );
}
