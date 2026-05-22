// Escalation submission drawer — Employee raises a claim "I was
// present, the system missed me" for a specific absent day.
//
// Submits POST /api/requests with type="escalation". The resulting
// request follows the normal Manager → HR approval chain; on
// hr_approved the backend locks the attendance record and forces
// absent=false, giving the employee a "Present (confirmed)" status.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BsInfoCircleFill } from "react-icons/bs";

import { api, extractApiError } from "../../api/client";
import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";

interface Props {
  employeeCode: string;
  fullName: string;
  isoDate: string;
  onClose: () => void;
  onSubmitted: () => void;
}

// Hardcoded reason options — each maps to a valid backend escalation category code
const REASON_OPTIONS: { code: string; label: string }[] = [
  {
    code: "camera_missed",
    label: "My face was not detected properly by the camera",
  },
  {
    code: "not_in_frame",
    label: "I was present, but detection may have failed due to camera angle/location",
  },
  {
    code: "different_entry",
    label: "I was present in another monitored location",
  },
  {
    code: "system_error",
    label: "Face detection may have failed because of lighting or visibility issues",
  },
];

function useSubmitEscalation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      reason_category: string;
      reason_text: string;
      target_date_start: string;
    }) =>
      api("/api/requests", {
        method: "POST",
        body: JSON.stringify({ type: "escalation", ...body }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["requests"] });
    },
  });
}

export function EscalationDrawer({
  employeeCode,
  fullName,
  isoDate,
  onClose,
  onSubmitted,
}: Props) {
  const { t } = useTranslation();
  const submit = useSubmitEscalation();

  const [reasonCode, setReasonCode] = useState("");
  const [inTime, setInTime] = useState("");
  const [outTime, setOutTime] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const parsedDate = (() => {
    try {
      return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
    } catch { return isoDate; }
  })();

  const commentTrimmed = comment.trim();
  const canSubmit = reasonCode.length > 0 && commentTrimmed.length >= 10 && !submit.isPending;

  const buildReasonText = () => {
    const parts: string[] = [];
    if (inTime || outTime) {
      const timeLine = [
        inTime ? `In: ${inTime}` : null,
        outTime ? `Out: ${outTime}` : null,
      ].filter(Boolean).join("  |  ");
      parts.push(`Estimated time present — ${timeLine}`);
    }
    parts.push(commentTrimmed);
    return parts.join("\n");
  };

  const onSubmit = async () => {
    setError(null);
    try {
      await submit.mutateAsync({
        reason_category: reasonCode,
        reason_text: buildReasonText(),
        target_date_start: isoDate,
      });
      onSubmitted();
      onClose();
    } catch (err) {
      setError(
        extractApiError(
          err,
          t("escalation.submitFailed", { defaultValue: "Failed to submit. Please try again." }) as string,
        ),
      );
    }
  };

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">
              {t("escalation.drawerTitle", { defaultValue: "Submit Escalation Request" }) as string}
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{fullName}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("calendar.close") as string}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="drawer-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Info banner */}
          <div style={{ background: "var(--info-soft)", border: "1px solid var(--info)", borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "flex-start", gap: 9, fontSize: 12.5, color: "var(--info-text)", lineHeight: 1.55 }}>
            <BsInfoCircleFill aria-hidden style={{ flexShrink: 0, marginTop: 2, fontSize: 14 }} />
            <span>
              {t("escalation.warningBody", {
                defaultValue: "Explain your situation. Manager and HR will review your escalation request and update your attendance status if approved.",
              }) as string}
            </span>
          </div>

          {/* Date row */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", fontSize: 12.5 }}>
            <Icon name="calendar" size={13} style={{ color: "var(--text-tertiary)" }} />
            <span style={{ color: "var(--text-tertiary)" }}>
              {t("escalation.dayInQuestion", { defaultValue: "Day in question:" }) as string}
            </span>
            <span className="mono" style={{ fontWeight: 700, color: "var(--text)" }}>{parsedDate}</span>
            <span className="pill pill-neutral" style={{ fontSize: 10.5 }}>{employeeCode}</span>
          </div>

          {/* Reason radio group */}
          <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
            <legend style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-tertiary)", marginBottom: 10, display: "block" }}>
              {t("escalation.reasonLabel", { defaultValue: "Why do you believe you were present?" }) as string}
              <span style={{ color: "var(--danger-text)", marginInlineStart: 4 }}>*</span>
            </legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {REASON_OPTIONS.map((opt) => {
                const selected = reasonCode === opt.code;
                return (
                  <label
                    key={opt.code}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                      padding: "10px 12px", borderRadius: 8,
                      border: `1.5px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                      background: selected ? "color-mix(in oklab, var(--accent) 8%, var(--bg))" : "var(--bg-elev)",
                      transition: "border-color 120ms ease, background 120ms ease",
                    }}
                  >
                    <input
                      type="radio"
                      name="esc-reason"
                      value={opt.code}
                      checked={selected}
                      onChange={() => setReasonCode(opt.code)}
                      style={{ marginTop: 2, accentColor: "var(--accent)", flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.45 }}>
                      {opt.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* In Time / Out Time */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-tertiary)", marginBottom: 8 }}>
              {t("escalation.estimatedTime", { defaultValue: "Estimated time you were present" }) as string}
              <span style={{ fontSize: 10, fontWeight: 400, textTransform: "none", marginInlineStart: 6, opacity: 0.7 }}>
                ({t("common.optional", { defaultValue: "optional" }) as string})
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label htmlFor="esc-in-time" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
                  {t("escalation.inTime", { defaultValue: "In Time" }) as string}
                </label>
                <input
                  id="esc-in-time"
                  type="time"
                  value={inTime}
                  onChange={(e) => setInTime(e.target.value)}
                  style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 13, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", outline: "none", width: "100%" }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label htmlFor="esc-out-time" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
                  {t("escalation.outTime", { defaultValue: "Out Time" }) as string}
                </label>
                <input
                  id="esc-out-time"
                  type="time"
                  value={outTime}
                  onChange={(e) => setOutTime(e.target.value)}
                  style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 13, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", outline: "none", width: "100%" }}
                />
              </div>
            </div>
          </div>

          {/* Explanation textarea */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="esc-comment" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-tertiary)" }}>
              {t("escalation.commentLabel", { defaultValue: "Explain what happened (minimum 10 characters)" }) as string}
              <span style={{ color: "var(--danger-text)", marginInlineStart: 4 }}>*</span>
            </label>
            <textarea
              id="esc-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              placeholder={t("escalation.commentPlaceholder", {
                defaultValue: "e.g. I arrived at 07:30 via the side entrance — the main camera was facing away.",
              }) as string}
              style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 13, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-sans)", outline: "none", resize: "vertical", minHeight: 90, width: "100%" }}
            />
            <div style={{ fontSize: 11, color: commentTrimmed.length > 0 && commentTrimmed.length < 10 ? "var(--danger-text)" : "var(--text-tertiary)" }}>
              {commentTrimmed.length} / 10 {t("escalation.charsMin", { defaultValue: "chars minimum" }) as string}
            </div>
          </div>

          {/* What happens next */}
          <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
            <b style={{ color: "var(--text)", display: "block", marginBottom: 4 }}>
              {t("escalation.whatHappens", { defaultValue: "What happens next?" }) as string}
            </b>
            {t("escalation.whatHappensBody", {
              defaultValue: "1. Your manager reviews the request.\n2. If approved, HR reviews it.\n3. Once both approve, your attendance is updated to Present automatically.",
            }) as string}
          </div>

          {error && (
            <div role="alert" style={{ background: "var(--danger-soft)", color: "var(--danger-text)", border: "1px solid var(--danger)", borderRadius: 7, padding: "8px 12px", fontSize: 12.5 }}>
              {error}
            </div>
          )}
        </div>

        <div className="drawer-foot" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={submit.isPending}>
            {t("common.cancel", { defaultValue: "Cancel" }) as string}
          </button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={!canSubmit}>
            {submit.isPending
              ? t("escalation.submitting", { defaultValue: "Submitting…" }) as string
              : t("escalation.submitButton", { defaultValue: "Submit Request" }) as string}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}
