// Request-related cards shown under the Day detail status hero:
//   * EscalationDetails — present confirmed by an approved escalation
//     (employee-submitted timings + approval chain)
//   * RequestPendingCard — absent day with an open exception/escalation;
//     Manager / HR decide inline (same endpoints + role gates as before)
//   * ApprovedAbsenceCard — absent day whose exception/leave was approved
//   * CameraGapsCard — cameras offline during the day (API camera_gaps)

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api, extractApiError } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { formatMinutes } from "../attendance/timeFormat";
import type { CameraGap, DayDetail, EscalationRequestSnapshot } from "./types";

// The EscalationDrawer bakes in/out times into reason_text as:
// "Estimated time present — In: HH:MM  |  Out: HH:MM\n<comment>"
export function parseEscalationTimes(reasonText: string | null | undefined): {
  inTime: string | null;
  outTime: string | null;
  comment: string;
} {
  if (!reasonText) return { inTime: null, outTime: null, comment: "" };
  const lines = reasonText.split("\n");
  const first = lines[0] ?? "";
  const PREFIX = "Estimated time present — ";
  if (!first.startsWith(PREFIX)) {
    return { inTime: null, outTime: null, comment: reasonText };
  }
  const parts = first.slice(PREFIX.length).split("  |  ");
  let inTime: string | null = null;
  let outTime: string | null = null;
  for (const p of parts) {
    const s = p.trim();
    if (s.startsWith("In: ")) inTime = s.slice(4);
    else if (s.startsWith("Out: ")) outTime = s.slice(5);
  }
  return { inTime, outTime, comment: lines.slice(1).join("\n") };
}

function TimingPair({ inTime, outTime }: { inTime: string | null; outTime: string | null }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  return (
    <div className="dd-timing">
      <div className="dd-label">
        {t("calendar.absent.submittedTimings", { defaultValue: "Employee-submitted timings" }) as string}
      </div>
      <div className="dd-timing-row">
        <span>
          {t("calendar.inTime", { defaultValue: "In time" }) as string}
          <b className="mono">{inTime ? dt.formatLocalTime(inTime) || inTime : "—"}</b>
        </span>
        <span aria-hidden className="dd-timing-arrow">→</span>
        <span>
          {t("calendar.outTime", { defaultValue: "Out time" }) as string}
          <b className="mono">{outTime ? dt.formatLocalTime(outTime) || outTime : "—"}</b>
        </span>
      </div>
    </div>
  );
}

function Step({
  done,
  current = false,
  label,
  actor,
  meta,
  comment,
}: {
  done: boolean;
  current?: boolean;
  label: string;
  actor?: string | null | undefined;
  meta?: string | null | undefined;
  comment?: string | null | undefined;
}) {
  return (
    <li className={`dd-step${done ? " is-done" : current ? " is-current" : ""}`}>
      <span aria-hidden className="dd-step-dot">
        {done && <Icon name="check" size={10} />}
      </span>
      <div className="dd-step-body">
        <div className="dd-step-label">
          {label}
          {actor && <span className="dd-step-actor"> · {actor}</span>}
        </div>
        {meta && <div className="dd-step-meta">{meta}</div>}
        {comment && <div className="dd-step-comment">“{comment}”</div>}
      </div>
    </li>
  );
}

export function EscalationDetails({
  note,
  snapshot,
}: {
  note: string | null;
  snapshot: EscalationRequestSnapshot | null;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const fmt = (iso: string | null | undefined) => (iso ? dt.formatDateTime(iso) : null);
  if (!note && !snapshot) return null;

  const parsed = parseEscalationTimes(snapshot?.reason_text);
  const hasTimings = parsed.inTime !== null || parsed.outTime !== null;
  const submittedComment = hasTimings
    ? (parsed.comment || (snapshot?.reason_category ?? null))
    : (snapshot?.reason_text ?? snapshot?.reason_category ?? null);

  return (
    <div className="dd-card">
      <div className="dd-card-title">
        {t("escalation.approvalChain", { defaultValue: "Approval chain" }) as string}
      </div>
      {note && (
        <p className="dd-card-note">
          <b>{t("escalation.confirmedReason", { defaultValue: "Reason:" }) as string}</b> {note}
        </p>
      )}
      {snapshot && hasTimings && <TimingPair inTime={parsed.inTime} outTime={parsed.outTime} />}
      {snapshot && (
        <ol className="dd-steps">
          <Step
            done
            label={t("escalation.chainSubmitted", { defaultValue: "Submitted" }) as string}
            meta={fmt(snapshot.submitted_at)}
            comment={submittedComment}
          />
          <Step
            done={!!snapshot.manager_decision_at}
            label={t("escalation.chainManager", { defaultValue: "Manager reviewed" }) as string}
            actor={snapshot.manager_name}
            meta={fmt(snapshot.manager_decision_at)}
            comment={snapshot.manager_comment}
          />
          <Step
            done={!!snapshot.hr_decision_at}
            label={t("escalation.chainHR", { defaultValue: "HR approved — present confirmed" }) as string}
            actor={snapshot.hr_name}
            meta={fmt(snapshot.hr_decision_at)}
            comment={snapshot.hr_comment}
          />
        </ol>
      )}
    </div>
  );
}

export function RequestPendingCard({
  detail,
  currentRole,
  onDecisionMade,
}: {
  detail: DayDetail;
  currentRole: string | null;
  onDecisionMade: () => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const req = detail.pending_request!;

  const [showReject, setShowReject] = useState(false);
  const [comment, setComment] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const fmt = (iso: string): string => dt.formatDateTime(iso) || iso;
  const managerDone = req.status === "manager_approved";

  const typeLabel = req.request_type === "escalation"
    ? (t("calendar.absent.typeEscalation", { defaultValue: "Escalation" }) as string)
    : (t("calendar.absent.typeException", { defaultValue: "Exception request" }) as string);

  // Who can act and on which endpoint — unchanged.
  const canManagerDecide = currentRole === "Manager" && req.status === "submitted";
  const canHRDecide = currentRole === "HR" && req.status === "manager_approved";
  const canDecide = canManagerDecide || canHRDecide;
  const decisionEndpoint = canManagerDecide
    ? `/api/requests/${req.request_id}/manager-decide`
    : `/api/requests/${req.request_id}/hr-decide`;

  const decide = async (decision: "approve" | "reject") => {
    setDeciding(true);
    setDecisionError(null);
    try {
      await api(decisionEndpoint, {
        method: "POST",
        body: JSON.stringify({ decision, comment: comment.trim() }),
      });
      onDecisionMade();
    } catch (err) {
      setDecisionError(extractApiError(err, t("calendar.absent.decisionFailed", { defaultValue: "Failed to submit decision. Please try again." }) as string));
      setDeciding(false);
    }
  };

  const esc = req.request_type === "escalation" ? parseEscalationTimes(req.reason_text) : null;
  const escHasTimings = !!esc && (esc.inTime !== null || esc.outTime !== null);

  return (
    <div className="dd-card">
      <div className="dd-card-head">
        <div className="dd-card-title">
          {req.request_type === "escalation"
            ? (t("calendar.absent.pendingTitleEscalation", { defaultValue: "Escalation under review" }) as string)
            : (t("calendar.absent.pendingTitleException", { defaultValue: "Exception request under review" }) as string)}
        </div>
        <span className="pill pill-accent">
          {managerDone
            ? (t("calendar.absent.awaitingHR", { defaultValue: "Awaiting HR review" }) as string)
            : (t("calendar.absent.awaitingManager", { defaultValue: "Awaiting manager review" }) as string)}
        </span>
      </div>

      <ol className="dd-progress" aria-label={t("calendar.absent.progressTitle", { defaultValue: "Request progress" }) as string}>
        <li className="is-done">{t("calendar.absent.stepSubmitted", { defaultValue: "Submitted" }) as string}</li>
        <li className={managerDone ? "is-done" : "is-current"}>{t("calendar.absent.stepManager", { defaultValue: "Manager" }) as string}</li>
        <li className={managerDone ? "is-current" : undefined}>{t("calendar.absent.stepHR", { defaultValue: "HR review" }) as string}</li>
        <li>
          {req.request_type === "escalation"
            ? (t("calendar.absent.stepPresent", { defaultValue: "Confirmed" }) as string)
            : (t("calendar.absent.stepApproved", { defaultValue: "Approved" }) as string)}
        </li>
      </ol>

      <dl className="dd-facts-list">
        <div><dt>{t("calendar.absent.typeLabel", { defaultValue: "Type" }) as string}</dt><dd>{typeLabel}</dd></div>
        <div><dt>{t("calendar.absent.reasonLabel", { defaultValue: "Reason" }) as string}</dt><dd>{req.reason_category}</dd></div>
        <div><dt>{t("calendar.absent.submittedAt", { defaultValue: "Submitted" }) as string}</dt><dd className="mono">{fmt(req.submitted_at)}</dd></div>
        {req.manager_name && (
          <div><dt>{t("calendar.absent.assignedTo", { defaultValue: "Assigned to" }) as string}</dt><dd><b>{req.manager_name}</b></dd></div>
        )}
        {req.request_type !== "escalation" && req.reason_text && (
          <div><dt>{t("calendar.absent.detailsLabel", { defaultValue: "Details" }) as string}</dt><dd><i>“{req.reason_text}”</i></dd></div>
        )}
        {esc && !escHasTimings && req.reason_text && (
          <div><dt>{t("calendar.absent.detailsLabel", { defaultValue: "Details" }) as string}</dt><dd><i>“{req.reason_text}”</i></dd></div>
        )}
      </dl>

      {esc && escHasTimings && <TimingPair inTime={esc.inTime} outTime={esc.outTime} />}
      {esc && escHasTimings && esc.comment && (
        <p className="dd-card-note">
          <b>{t("calendar.absent.commentLabel", { defaultValue: "Employee comment" }) as string}:</b> <i>“{esc.comment}”</i>
        </p>
      )}

      {canDecide ? (
        <div className="dd-decide">
          <div className="dd-decide-head">
            {t("calendar.absent.decisionTitle", { defaultValue: "Your decision", role: currentRole ?? "" }) as string}
            <span className="pill pill-neutral">{currentRole}</span>
          </div>
          {!showReject ? (
            <div className="dd-decide-row">
              <button type="button" className="btn btn-primary" onClick={() => decide("approve")} disabled={deciding}>
                {deciding
                  ? (t("calendar.absent.approving", { defaultValue: "Approving…" }) as string)
                  : (t("calendar.absent.approveBtn", { defaultValue: "✓ Approve" }) as string)}
              </button>
              <button type="button" className="btn dd-btn-danger-ghost" onClick={() => setShowReject(true)} disabled={deciding}>
                {t("calendar.absent.rejectBtn", { defaultValue: "✕ Reject" }) as string}
              </button>
            </div>
          ) : (
            <div className="dd-decide-reject">
              <label className="dd-label" htmlFor={`dd-reject-${req.request_id}`}>
                {t("calendar.absent.rejectCommentLabel", { defaultValue: "Reason for rejection (optional)" }) as string}
              </label>
              <textarea
                id={`dd-reject-${req.request_id}`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder={t("calendar.absent.rejectCommentPlaceholder", { defaultValue: "Explain why this request is being rejected…" }) as string}
              />
              <div className="dd-decide-row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => { setShowReject(false); setComment(""); setDecisionError(null); }}
                  disabled={deciding}
                >
                  {t("common.cancel", { defaultValue: "Cancel" }) as string}
                </button>
                <button type="button" className="btn btn-danger" onClick={() => decide("reject")} disabled={deciding}>
                  {deciding
                    ? (t("calendar.absent.rejecting", { defaultValue: "Rejecting…" }) as string)
                    : (t("calendar.absent.confirmReject", { defaultValue: "Confirm Rejection" }) as string)}
                </button>
              </div>
            </div>
          )}
          {decisionError && <div role="alert" className="dd-error-line">{decisionError}</div>}
        </div>
      ) : (
        <p className="dd-card-foot">
          {t("calendar.absent.pendingGuidance", { defaultValue: "Your request is currently under review. You will receive a notification when a decision is made." }) as string}
        </p>
      )}
    </div>
  );
}

export function ApprovedAbsenceCard({ detail }: { detail: DayDetail }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const req = detail.approved_request!;
  const fmt = (iso: string | null | undefined): string | null => (iso ? dt.formatDateTime(iso) : null);

  const typeLabel = req.request_type === "leave"
    ? (t("calendar.absent.typeLeave", { defaultValue: "Leave request" }) as string)
    : (t("calendar.absent.typeException", { defaultValue: "Exception request" }) as string);

  return (
    <div className="dd-card">
      <div className="dd-card-head">
        <div className="dd-card-title">
          {t("calendar.absent.approvalDetailsTitle", { defaultValue: "Approval details" }) as string}
        </div>
        <a href="/my-requests" className="btn btn-sm btn-ghost">
          {t("calendar.absent.viewBtn", { defaultValue: "View full request" }) as string}
          <Icon name="chevronRight" size={12} />
        </a>
      </div>
      <dl className="dd-facts-list">
        <div><dt>{t("calendar.absent.typeLabel", { defaultValue: "Type" }) as string}</dt><dd>{typeLabel}</dd></div>
        <div><dt>{t("calendar.absent.reasonLabel", { defaultValue: "Reason" }) as string}</dt><dd>{req.reason_category}</dd></div>
        {req.reason_text && (
          <div><dt>{t("calendar.absent.detailsLabel", { defaultValue: "Details" }) as string}</dt><dd><i>“{req.reason_text}”</i></dd></div>
        )}
      </dl>
      <ol className="dd-steps">
        <Step done label={t("calendar.absent.chainSubmitted", { defaultValue: "Submitted by employee" }) as string} meta={fmt(req.submitted_at)} />
        {req.manager_name && (
          <Step
            done
            label={t("calendar.absent.chainManagerApproved", { defaultValue: "Manager approved" }) as string}
            actor={req.manager_name}
            meta={fmt(req.manager_decision_at)}
            comment={req.manager_comment ?? null}
          />
        )}
        {req.hr_name && (
          <Step
            done
            label={t("calendar.absent.chainHRApproved", { defaultValue: "HR approved" }) as string}
            actor={req.hr_name}
            meta={fmt(req.hr_decision_at)}
            comment={req.hr_comment ?? null}
          />
        )}
      </ol>
    </div>
  );
}

export function CameraGapsCard({ gaps }: { gaps: CameraGap[] }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  if (gaps.length === 0) return null;
  return (
    <div className="dd-card dd-card-quiet">
      <div className="dd-card-title">
        <Icon name="camera" size={13} />
        {t("dayDetail.cameraGaps", { defaultValue: "Cameras offline during the day" }) as string}
      </div>
      <ul className="dd-gaps">
        {gaps.map((g) => (
          <li key={`${g.camera_id}-${g.offline_from}`}>
            <span className="dd-gap-name">{g.camera_name}</span>
            <span className="mono">
              {dt.formatTime(g.offline_from)} – {dt.formatTime(g.offline_to)}
            </span>
            <span className="dd-gap-dur">{formatMinutes(g.offline_minutes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Why absent" — the engine's absent rule laid out as checks, plus the
 *  camera-outage and request context the API returns for absent days. */
export function AbsentChecklist({
  detail: d,
  hint,
}: {
  detail: DayDetail;
  hint: string | null;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const gaps = d.camera_gaps;
  const req: "approved" | "pending" | "none" = d.approved_request ? "approved" : d.pending_request ? "pending" : "none";
  const shift = d.policy_shift_start && d.policy_shift_end
    ? `${dt.formatLocalTime(d.policy_shift_start)} – ${dt.formatLocalTime(d.policy_shift_end)}`
    : null;

  const rows: Array<{ tone: "bad" | "ok" | "warn" | "info"; title: string; sub: string | null }> = [
    {
      tone: "bad",
      title: t("dayDetail.absent.noFace", { defaultValue: "No face detected" }) as string,
      sub: shift
        ? (t("dayDetail.absent.noFaceShift", { defaultValue: "No camera matched this employee during the {{shift}} shift.", shift }) as string)
        : (t("calendar.emptyEvidenceAbsent.sub", { defaultValue: "No detection events were recorded on this date." }) as string),
    },
    {
      tone: "bad",
      title: t("dayDetail.absent.noLeave", { defaultValue: "No approved leave or holiday" }) as string,
      sub: t("dayDetail.absent.noLeaveSub", { defaultValue: "It is a working day for this employee, so attendance was expected." }) as string,
    },
    gaps.length > 0
      ? {
          tone: "warn",
          title: t("dayDetail.absent.cameraGap", { defaultValue: "Camera offline during the day" }) as string,
          sub: gaps
            .map((g) => `${g.camera_name} ${dt.formatTime(g.offline_from)} – ${dt.formatTime(g.offline_to)} (${formatMinutes(g.offline_minutes)})`)
            .join(" · "),
        }
      : {
          tone: "ok",
          title: t("dayDetail.absent.noCameraGap", { defaultValue: "No camera outage recorded" }) as string,
          sub: t("dayDetail.absent.noCameraGapSub", { defaultValue: "Cameras were reporting, so a missed detection is less likely." }) as string,
        },
    req === "approved"
      ? { tone: "ok", title: t("dayDetail.absent.reqApproved", { defaultValue: "Request approved" }) as string, sub: t("calendar.absent.approvedNote", { defaultValue: "This absence has been reviewed and approved. No further action is required." }) as string }
      : req === "pending"
        ? { tone: "info", title: t("dayDetail.absent.reqPending", { defaultValue: "Request under review" }) as string, sub: t("calendar.absent.pendingSub", { defaultValue: "A request for this day is currently being reviewed. Attendance will update automatically once all approvals are complete." }) as string }
        : { tone: "info", title: t("dayDetail.absent.reqNone", { defaultValue: "No request submitted" }) as string, sub: hint },
  ];

  const icon = (tone: string) =>
    tone === "ok" ? <Icon name="check" size={11} /> : tone === "bad" ? <Icon name="x" size={11} /> : <Icon name="info" size={11} />;

  return (
    <div className="dd-card">
      <div className="dd-card-title">{t("dayDetail.absent.why", { defaultValue: "Why this day is absent" }) as string}</div>
      <ul className="dd-checks">
        {rows.map((r, i) => (
          <li key={i} className={`is-${r.tone}`}>
            <span aria-hidden className="dd-check-icon">{icon(r.tone)}</span>
            <div>
              <div className="dd-check-title">{r.title}</div>
              {r.sub && <div className="dd-check-sub">{r.sub}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
