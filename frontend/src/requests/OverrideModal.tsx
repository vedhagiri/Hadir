// Admin override modal. Carries the load-bearing red banner ("This
// will be audit-logged and visible to all parties") and a comment
// field that requires at least 10 characters server-side; the
// client mirrors the rule for UX. Submit hits POST
// /api/requests/{id}/admin-override.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { ChoiceCards, Field, FormFooter, FormNotice, FormSection } from "../components/FormKit";
import { Icon } from "../shell/Icon";
import { useAdminOverride } from "./hooks";
import type { RequestRecord } from "./types";
import { FormModal, errorDetail } from "./workflowUi";

const MIN_COMMENT = 10;

interface Props {
  request: RequestRecord;
  onClose: () => void;
}

export function OverrideModal({ request, onClose }: Props) {
  const { t } = useTranslation();
  const override = useAdminOverride(request.id);
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);

  const trimmedLength = comment.trim().length;
  const tooShort = trimmedLength < MIN_COMMENT;

  // Mirror the backend's _identify_previous_decider precedence:
  // HR wins if there's an HR decision, then Manager. If neither has
  // decided yet (Admin acting on a fresh ``submitted`` row) we name
  // the workflow stage instead.
  const stage = (() => {
    if (request.hr_decision_at) return t("overrideModal.stageHr", { defaultValue: "HR" });
    if (request.manager_decision_at) return t("overrideModal.stageManager", { defaultValue: "Manager" });
    if (request.status === "submitted") return t("overrideModal.stagePendingManager", { defaultValue: "the pending Manager" });
    if (request.status === "manager_approved") return t("overrideModal.stagePendingHr", { defaultValue: "the pending HR review" });
    return t("overrideModal.stagePrior", { defaultValue: "the prior" });
  })();

  const submit = async () => {
    setError(null);
    setCommentError(null);
    if (tooShort) {
      setCommentError(
        t("overrideModal.tooShort", {
          defaultValue: "Comment must be at least {{min}} characters (you typed {{n}}).",
          min: MIN_COMMENT,
          n: trimmedLength,
        }),
      );
      return;
    }
    try {
      await override.mutateAsync({ decision, comment: comment.trim() });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? errorDetail(err, t("overrideModal.failed", { defaultValue: "Override failed" }))
          : t("overrideModal.failed", { defaultValue: "Override failed" }),
      );
    }
  };

  return (
    <FormModal
      onClose={onClose}
      onSubmit={() => void submit()}
      busy={override.isPending}
      size="md"
      icon={<Icon name="shield" size={18} />}
      eyebrow={t("overrideModal.eyebrow", { defaultValue: "Admin override" })}
      title={t("overrideModal.title", { defaultValue: "Override request #{{id}}", id: request.id })}
      subtitle={t("overrideModal.subtitle", {
        defaultValue: "Replace the current decision on this request with your own.",
      })}
      footer={
        <FormFooter
          onCancel={onClose}
          danger
          submitting={override.isPending}
          submittingLabel={t("overrideModal.submitting", { defaultValue: "Submitting…" })}
          canSubmit={!tooShort}
          submitLabel={
            decision === "approve"
              ? t("overrideModal.overrideApprove", { defaultValue: "Override · Approve" })
              : t("overrideModal.overrideReject", { defaultValue: "Override · Reject" })
          }
        />
      }
    >
      {error && <FormNotice tone="danger">{error}</FormNotice>}

      {/* Red banner — load-bearing copy. */}
      <FormNotice
        tone="danger"
        title={t("overrideModal.bannerTitle", { defaultValue: "Overriding the {{stage}} decision.", stage })}
      >
        {t("overrideModal.bannerBody", {
          defaultValue:
            "This will be audit-logged and visible to all parties (the original {{stage}} decider, the employee, and any administrator reviewing the request later).",
          stage,
        })}
      </FormNotice>

      <FormSection
        title={t("overrideModal.decision", { defaultValue: "Decision" })}
        description={t("overrideModal.decisionDesc", { defaultValue: "The outcome that replaces the current decision." })}
      >
        <ChoiceCards<"approve" | "reject">
          label={t("overrideModal.decision", { defaultValue: "Decision" })}
          value={decision}
          onChange={setDecision}
          options={[
            {
              value: "approve",
              title: t("requestDetail.approve", { defaultValue: "Approve" }),
              icon: <Icon name="check" size={16} />,
            },
            {
              value: "reject",
              title: t("requestDetail.reject", { defaultValue: "Reject" }),
              icon: <Icon name="x" size={16} />,
            },
          ]}
        />
        <Field
          label={t("overrideModal.comment", { defaultValue: "Comment (required, min {{min}} characters)", min: MIN_COMMENT })}
          htmlFor="override-comment"
          required
          span={2}
          help={t("overrideModal.commentCount", { defaultValue: "{{n}} characters.", n: trimmedLength })}
          error={
            commentError ??
            (tooShort && trimmedLength > 0
              ? t("overrideModal.commentShort", {
                  defaultValue: "{{n}} / {{min}} — comment must be at least {{min}} characters.",
                  n: trimmedLength,
                  min: MIN_COMMENT,
                })
              : null)
          }
        >
          <textarea
            id="override-comment"
            className="textarea"
            rows={4}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              setCommentError(null);
            }}
            placeholder={t("overrideModal.commentPlaceholder", { defaultValue: "Why are you overriding this decision? This is the audit record." })}
          />
        </Field>
      </FormSection>
    </FormModal>
  );
}
