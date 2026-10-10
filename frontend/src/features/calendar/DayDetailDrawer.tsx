// Day detail — one employee, one date. Shared by the Calendar drawer,
// Daily attendance (AttendanceDrawer), My Attendance, the Employee
// report and the employee profile Attendance tab (DayDetailContent).
//
// Layout (Oct 2026 redesign):
//   1. Status hero — one distinct look per status, headline + one-line
//      meaning, flags, and the status' call to action.
//   2. Key numbers — In · Out · Hours vs required · Overtime (or a
//      single "No detections" line when there is nothing to count).
//   3. Timeline — shift window shaded behind presence + detections.
//   4. Policy & schedule — compact policy facts + 7-day week row.
//   5. Evidence — face-crop gallery with click-to-preview.
// Pure status logic lives in dayDetailModel.ts; styles in day-detail.css.

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

import { extractApiError } from "../../api/client";
import { DrawerShell } from "../../components/DrawerShell";
import { SkeletonLine } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { InlineAlert } from "../cameras/coreUi";
import { useTenantDateTime } from "../../util/datetime";
import { useMe } from "../../auth/AuthProvider";
import { primaryRole } from "../../types";
import { useRegenerateAttendanceForEmployee } from "../attendance/hooks";
import { formatMinutes } from "../attendance/timeFormat";
import { DOW_KEYS, avatarBg, initials } from "./calendarUi";
import { EscalationDrawer } from "./EscalationDrawer";
import { useDayDetail } from "./hooks";
import {
  buildDayView,
  heroOffersSubmit,
  policyBands,
  toMinutes,
  type DayKind,
  type DayView,
} from "./dayDetailModel";
import { DayDetailTimeline } from "./DayDetailTimeline";
import { EvidenceGallery, bestConfidence } from "./DayDetailEvidence";
import {
  AbsentChecklist,
  ApprovedAbsenceCard,
  EscalationDetails,
  RequestPendingCard,
} from "./DayDetailRequests";
import type { DayDetail } from "./types";

import "./day-detail.css";

interface Props {
  employeeId: number;
  isoDate: string;
  onClose: () => void;
  onSubmitException?: (isoDate: string) => void;
}

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function useHeaderDate(): (iso: string) => string {
  const { i18n } = useTranslation();
  const locale = i18n.language === "ar" ? "ar-OM" : "en-GB";
  return (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(locale, o);
    // "Fri, 9 Oct 2026"
    return `${part({ weekday: "short" })}, ${part({ day: "numeric" })} ${part({ month: "short" })} ${part({ year: "numeric" })}`;
  };
}

function useWeekdayName(): (iso: string) => string {
  const { i18n } = useTranslation();
  const locale = i18n.language === "ar" ? "ar-OM" : "en-GB";
  return (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { weekday: "long" });
  };
}

// ---------------------------------------------------------------------------
// DayDetailContent — the reusable body (drawer + embedded profile tab).
// ---------------------------------------------------------------------------

export function DayDetailContent({
  employeeId,
  isoDate,
  onSubmitException,
}: {
  employeeId: number;
  isoDate: string;
  onSubmitException?: ((isoDate: string) => void) | null;
}) {
  const { t } = useTranslation();
  const detail = useDayDetail(employeeId, isoDate);
  const headerDate = useHeaderDate();

  const [highlightedEventId, setHighlightedEventId] = useState<number | null>(null);
  const [showEscalation, setShowEscalation] = useState(false);
  const me = useMe();
  const currentRole = me.data ? primaryRole(me.data.roles) : null;
  const isEmployee = currentRole === "Employee";
  const qc = useQueryClient();

  const onDecisionMade = useCallback(() => {
    const month = isoDate.slice(0, 7);
    void qc.invalidateQueries({ queryKey: ["calendar"] });
    void qc.invalidateQueries({ queryKey: ["attendance"] });
    void qc.invalidateQueries({ queryKey: ["requests"] });
    void qc.refetchQueries({ queryKey: ["calendar", "day", employeeId, isoDate], exact: true });
    void qc.refetchQueries({ queryKey: ["calendar", "person", employeeId, month], exact: true });
  }, [qc, isoDate, employeeId]);

  const evidenceRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const registerRef = useCallback((eventId: number, el: HTMLDivElement | null) => {
    if (el) evidenceRefs.current.set(eventId, el);
    else evidenceRefs.current.delete(eventId);
  }, []);
  const onTimelineEventActivate = useCallback((eventId: number) => {
    const el = evidenceRefs.current.get(eventId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setHighlightedEventId(eventId);
    window.setTimeout(() => setHighlightedEventId(null), 2500);
  }, []);

  if (detail.isLoading) return <DayDetailSkeleton />;

  if (detail.isError || !detail.data) {
    return (
      <div className="dd-error" role="alert">
        <Icon name="info" size={16} />
        <span>{t("dayDetail.loadFailed", { defaultValue: "Couldn't load this day." }) as string}</span>
        <button type="button" className="btn btn-sm" onClick={() => void detail.refetch()} disabled={detail.isFetching}>
          <Icon name="refresh" size={12} />
          {t("common.retry", { defaultValue: "Retry" }) as string}
        </button>
      </div>
    );
  }

  const d = detail.data;
  const view = buildDayView(d);
  const raiseEscalation = isEmployee ? () => setShowEscalation(true) : null;
  // The shift window only means something on a working day — shading it
  // on a week off / holiday / leave would imply a shift was expected.
  const bands = view.overtimeDay || view.kind === "leave" || view.kind === "weekend" || view.kind === "holiday" ? [] : policyBands(d);
  const shiftLabel =
    !view.isFlex && d.policy_shift_start && d.policy_shift_end
      ? (t("dayDetail.shiftRange", { defaultValue: "Shift {{start}} – {{end}}", start: d.policy_shift_start, end: d.policy_shift_end }) as string)
      : null;

  // Nothing detected → the summary already states the expected shift;
  // an empty shaded bar would only repeat it.
  const showTimeline = view.worked;
  const showEvidence = d.evidence.length > 0 || view.kind === "present" || view.kind === "late";
  const showPolicy = view.kind !== "future" && view.kind !== "no_record";

  return (
    <div className="dd">
      <div className="dd-ident">
        <span className="mono">{d.employee_code}</span>
        {d.department_name && (
          <>
            <span aria-hidden className="dd-sep">·</span>
            <span>{d.department_name}</span>
          </>
        )}
        <span className="dd-ident-date">
          <span aria-hidden className="dd-sep">·</span>
          {headerDate(isoDate)}
        </span>
      </div>

      <div className="dd-cols">
        <div className="dd-col">
          <section className={`dd-summary dd-tone-${view.tone}`}>
            <StatusHero
              detail={d}
              view={view}
              isoDate={isoDate}
              onSubmitException={onSubmitException ?? null}
              onRaiseEscalation={raiseEscalation}
            />
            <KeyFacts detail={d} view={view} />
          </section>

          {view.kind === "escalation" && (
            <EscalationDetails note={d.escalation_note ?? null} snapshot={d.escalation_request ?? null} />
          )}
          {view.absentSub === "pending" && (
            <RequestPendingCard detail={d} currentRole={currentRole} onDecisionMade={onDecisionMade} />
          )}
          {view.absentSub === "approved" && <ApprovedAbsenceCard detail={d} />}
          {view.kind === "absent" && (
            <AbsentChecklist
              detail={d}
              hint={
                isEmployee
                  ? (t("calendar.absent.escalationHint", { defaultValue: "If you were present but the system missed you, submit an escalation request for manager and HR review." }) as string)
                  : (t("dayDetail.absent.noRequestSub", { defaultValue: "Nobody has raised an exception or escalation for this day yet." }) as string)
              }
            />
          )}

          {showTimeline && (
            <DdSection title={t("calendar.dayTimeline", { defaultValue: "Day timeline" }) as string}>
              <DayDetailTimeline
                intervals={d.timeline}
                evidence={d.evidence}
                inTime={d.in_time ?? null}
                outTime={d.out_time ?? null}
                totalMinutes={d.total_minutes ?? null}
                bands={bands}
                windowLabel={shiftLabel}
                onEventActivate={onTimelineEventActivate}
              />
            </DdSection>
          )}
        </div>

        {(showPolicy || showEvidence) && (
          <div className="dd-col dd-col-side">
            {showPolicy && <PolicyScheduleCard detail={d} isoDate={isoDate} />}
            {showEvidence && (
              <EvidenceSection
                detail={d}
                isoDate={isoDate}
                highlightedEventId={highlightedEventId}
                registerRef={registerRef}
              />
            )}
          </div>
        )}
      </div>

      {/* EscalationDrawer portals to #drawer-root via DrawerShell — safe
          even when DayDetailContent is rendered inside another drawer. */}
      {showEscalation && isEmployee && (
        <EscalationDrawer
          employeeCode={d.employee_code}
          fullName={d.full_name}
          isoDate={isoDate}
          onClose={() => setShowEscalation(false)}
          onSubmitted={onDecisionMade}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DayDetailDrawer — DrawerShell + header + DayDetailContent.
// ---------------------------------------------------------------------------

export function DayDetailDrawer({
  employeeId,
  isoDate,
  onClose,
  onSubmitException,
}: Props) {
  const { t } = useTranslation();
  // Same cache key as DayDetailContent — TanStack Query deduplicates.
  const detail = useDayDetail(employeeId, isoDate);
  const headerDate = useHeaderDate();
  const regen = useRegenerateAttendanceForEmployee();
  const [regenInfo, setRegenInfo] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);

  const exportHref =
    `/api/attendance/calendar/export?month=${isoDate.slice(0, 7)}` +
    `&employee_id=${employeeId}&date=${isoDate}`;

  const triggerRegen = () => {
    setRegenInfo(null);
    regen.mutate(
      { employee_id: employeeId, target_date: isoDate },
      {
        onSuccess: (resp) => {
          setRegenInfo({
            tone: "ok",
            text: resp.upserted
              ? (t("attendance.regenOk", {
                  defaultValue: "Refreshed attendance for {{date}}.",
                  date: resp.date,
                }) as string)
              : (t("attendance.regenNoPolicy", {
                  defaultValue:
                    "No policy resolves for {{date}} — nothing to refresh.",
                  date: resp.date,
                }) as string),
          });
        },
        onError: (err) => {
          setRegenInfo({
            tone: "err",
            text: (t("attendance.regenFailed", {
              defaultValue: "Regenerate failed: {{reason}}",
              reason: extractApiError(err, "request failed"),
            }) as string),
          });
        },
      },
    );
  };

  const d = detail.data;
  const view = d ? buildDayView(d) : null;
  const worked = d != null && (
    d.in_time != null ||
    (d.total_minutes != null && d.total_minutes > 0) ||
    d.timeline.length > 0
  );
  const disableExport =
    !d ||
    d.status === "no_record" ||
    d.status === "future" ||
    d.status === "absent" ||
    d.status === "waiting" ||
    (d.status === "weekend" && !worked) ||
    (d.status === "holiday" && !worked);

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer dd-drawer" aria-label={t("calendar.dayDetail", { defaultValue: "Day detail" }) as string}>
        <div className="drawer-head dd-head">
          <span aria-hidden className="dd-avatar" style={d ? { background: avatarBg(d.full_name) } : undefined}>
            {d ? initials(d.full_name) : ""}
          </span>
          <div className="dd-head-main">
            <div className="dd-head-row">
              <h2 className="dd-head-name">
                {d?.full_name ?? <SkeletonLine width={160} height={18} />}
              </h2>
              {view && <DayStatusPill kind={view.kind} />}
            </div>
            <div className="dd-head-sub">
              <span>{headerDate(isoDate)}</span>
              {d && (
                <>
                  <span aria-hidden className="dd-sep">·</span>
                  <span className="mono">{d.employee_code}</span>
                  {d.department_name && (
                    <>
                      <span aria-hidden className="dd-sep">·</span>
                      <span>{d.department_name}</span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="co-dd-actions dd-actions">
            <button
              type="button"
              className={`btn btn-sm dd-act${regen.isPending ? " is-busy" : ""}`}
              onClick={triggerRegen}
              disabled={regen.isPending}
              title={
                t("attendance.regenTooltip", {
                  defaultValue:
                    "Recompute this row from current camera events",
                }) as string
              }
            >
              <Icon name="refresh" size={12} />
              {regen.isPending
                ? (t("attendance.regenerating", {
                    defaultValue: "Regenerating…",
                  }) as string)
                : (t("attendance.regenFromEvents", {
                    defaultValue: "Regenerate",
                  }) as string)}
            </button>
            {disableExport ? (
              <button
                type="button"
                className="btn btn-sm dd-act"
                disabled
                title={t("dayDetail.exportNothing", { defaultValue: "Nothing to export — no time was recorded on this day" }) as string}
              >
                <Icon name="download" size={12} />
                {t("calendar.export") as string}
              </button>
            ) : (
              <a
                className="btn btn-sm dd-act"
                href={exportHref}
                target="_blank"
                rel="noopener noreferrer"
                title={t("dayDetail.exportTitle", { defaultValue: "Download this day's attendance" }) as string}
              >
                <Icon name="download" size={12} />
                {t("calendar.export") as string}
              </a>
            )}
            <span aria-hidden className="dd-act-sep" />
            <button
              className="icon-btn"
              onClick={onClose}
              aria-label={t("calendar.close") as string}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {regenInfo && (
          <div className="co-dd-notice">
            <InlineAlert tone={regenInfo.tone === "ok" ? "info" : "danger"} onClose={() => setRegenInfo(null)}>
              {regenInfo.text}
            </InlineAlert>
          </div>
        )}

        <div className="drawer-body">
          <DayDetailContent
            employeeId={employeeId}
            isoDate={isoDate}
            onSubmitException={onSubmitException ?? null}
          />
        </div>

        {/* The hero carries "Submit exception" on absent / waiting days;
            every other status keeps it here in the footer. */}
        {onSubmitException && d && !heroOffersSubmit(d) && (
          <div className="drawer-foot">
            <button
              type="button"
              className="btn"
              onClick={() => onSubmitException(isoDate)}
            >
              <Icon name="plus" size={12} />
              {t("calendar.submitException") as string}
            </button>
          </div>
        )}
      </div>
    </DrawerShell>
  );
}

// ---------------------------------------------------------------------------
// Status pill (header) + hero
// ---------------------------------------------------------------------------

const KIND_TONE: Record<DayKind, string> = {
  present: "present",
  escalation: "present",
  late: "late",
  absent: "absent",
  waiting: "waiting",
  leave: "leave",
  weekend: "weekoff",
  weekend_worked: "worked",
  holiday: "holiday",
  holiday_worked: "holiday",
  future: "muted",
  no_record: "muted",
};

function useKindLabel(): (k: DayKind) => string {
  const { t } = useTranslation();
  return (k) => {
    switch (k) {
      case "present": return t("calendar.status.present", { defaultValue: "Present" }) as string;
      case "escalation": return t("calendar.status.escalation_present", { defaultValue: "Present via Escalation" }) as string;
      case "late": return t("calendar.status.late", { defaultValue: "Late" }) as string;
      case "absent": return t("calendar.status.absent", { defaultValue: "Absent" }) as string;
      case "waiting": return t("dayDetail.pill.waiting", { defaultValue: "Not in yet" }) as string;
      case "leave": return t("dailyAttendance.pill.onLeave", { defaultValue: "On leave" }) as string;
      case "weekend": return t("dayDetail.pill.weekOff", { defaultValue: "Week off" }) as string;
      case "weekend_worked": return t("dayDetail.pill.weekOffWorked", { defaultValue: "Worked on week off" }) as string;
      case "holiday": return t("calendar.status.holiday", { defaultValue: "Holiday" }) as string;
      case "holiday_worked": return t("dayDetail.pill.holidayWorked", { defaultValue: "Worked on holiday" }) as string;
      case "future": return t("calendar.status.future", { defaultValue: "Future" }) as string;
      default: return t("calendar.status.no_record", { defaultValue: "No record" }) as string;
    }
  };
}

function DayStatusPill({ kind }: { kind: DayKind }) {
  const label = useKindLabel();
  return (
    <span className={`dd-pill dd-tone-${KIND_TONE[kind]}`}>
      <span aria-hidden className="dd-pill-dot" />
      {label(kind)}
    </span>
  );
}

const HERO_ICON: Record<DayKind, ReactNode> = {
  present: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 9.8" /></>,
  escalation: <><path d="M12 3l7 3v5.5c0 4.2-3 7.8-7 9.5-4-1.7-7-5.3-7-9.5V6z" /><path d="M8.8 12.2l2.2 2.2 4.3-4.4" /></>,
  late: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M5 3L2 6M19 3l3 3" /></>,
  absent: <><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></>,
  waiting: <><path d="M7 3h10M7 21h10M8 3c0 4 8 5 8 9s-8 5-8 9M16 3c0 4-8 5-8 9s8 5 8 9" /></>,
  leave: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  weekend: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4M8 13h2M14 13h2M8 17h2" /></>,
  weekend_worked: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4M8.5 15l2.5 2.5 4.5-4.5" /></>,
  holiday: <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z" />,
  holiday_worked: <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z" />,
  future: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /><circle cx="8" cy="14.5" r="0.6" /><circle cx="12" cy="14.5" r="0.6" /><circle cx="16" cy="14.5" r="0.6" /></>,
  no_record: <><circle cx="12" cy="12" r="9" strokeDasharray="3 3" /><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.3M12 16.8v.2" /></>,
};

function StatusHero({
  detail: d,
  view,
  isoDate,
  onSubmitException,
  onRaiseEscalation,
}: {
  detail: DayDetail;
  view: DayView;
  isoDate: string;
  onSubmitException: ((isoDate: string) => void) | null;
  onRaiseEscalation: (() => void) | null;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const weekday = useWeekdayName();
  const time = (s: string | null | undefined) => dt.formatLocalTime(s ?? null) || "—";

  const chips: Array<{ tone: string; text: string; title?: string }> = [];
  const ot = d.overtime_minutes;
  const singleDetection = d.in_time != null && d.out_time == null;
  // On-time cutoff: shift start + grace (Fixed) / end of arrival window (Flex).
  const cutoffMin = view.expectedIn ? toMinutes(view.expectedIn) : null;
  const cutoff = cutoffMin != null
    ? dt.formatLocalTime(`${String(Math.floor(((cutoffMin + view.graceMinutes) % 1440) / 60)).padStart(2, "0")}:${String((cutoffMin + view.graceMinutes) % 60).padStart(2, "0")}`)
    : null;

  let title: string;
  let meaning: string;

  switch (view.kind) {
    case "present":
      title = t("dayDetail.hero.present.title", { defaultValue: "Present · on time" }) as string;
      meaning = cutoff
        ? (t("dayDetail.hero.present.meaning", { defaultValue: "Arrived {{in}} · on-time cutoff {{cutoff}}", in: time(d.in_time), cutoff }) as string)
        : (t("dayDetail.hero.present.meaningNoPolicy", { defaultValue: "Arrived {{in}}", in: time(d.in_time) }) as string);
      break;
    case "late":
      title = view.lateByMinutes != null && view.lateByMinutes > 0
        ? (t("dayDetail.hero.late.title", { defaultValue: "Late by {{dur}}", dur: formatMinutes(view.lateByMinutes) }) as string)
        : (t("calendar.status.late", { defaultValue: "Late" }) as string);
      meaning = !view.expectedIn
        ? (t("dayDetail.hero.present.meaningNoPolicy", { defaultValue: "Arrived {{in}}", in: time(d.in_time) }) as string)
        : view.isFlex
          ? (t("dayDetail.hero.late.meaningFlex", { defaultValue: "Must arrive by {{by}} · arrived {{in}}", by: time(view.expectedIn), in: time(d.in_time) }) as string)
          : view.graceMinutes > 0
            ? (t("dayDetail.hero.late.meaningGrace", { defaultValue: "Expected by {{by}} ({{start}} + {{grace}} min grace) · arrived {{in}}", by: cutoff ?? "—", start: time(view.expectedIn), grace: view.graceMinutes, in: time(d.in_time) }) as string)
            : (t("dayDetail.hero.late.meaning", { defaultValue: "Expected by {{by}} · arrived {{in}}", by: time(view.expectedIn), in: time(d.in_time) }) as string);
      break;
    case "escalation":
      title = t("dayDetail.hero.escalation.title", { defaultValue: "Present · confirmed by escalation" }) as string;
      meaning = t("escalation.confirmedSub", { defaultValue: "An escalation was raised, reviewed by Manager and HR, and approved. Attendance is marked as Present." }) as string;
      break;
    case "absent":
      title = t("calendar.status.absent", { defaultValue: "Absent" }) as string;
      if (view.absentSub === "approved") {
        meaning = d.approved_request?.request_type === "leave"
          ? (t("calendar.absent.approvedTitleLeave", { defaultValue: "Leave approved — absence on record" }) as string)
          : (t("calendar.absent.approvedTitleException", { defaultValue: "Exception approved — absence on record" }) as string);
        chips.push({ tone: "present", text: t("dayDetail.chip.approved", { defaultValue: "Request approved" }) as string });
      } else {
        meaning = t("dayDetail.hero.absent.meaning", { defaultValue: "No detection and no approved leave for this day." }) as string;
        if (view.absentSub === "pending") chips.push({ tone: "waiting", text: t("dayDetail.chip.pending", { defaultValue: "Request under review" }) as string });
        if (view.absentSub === "camera_offline") chips.push({ tone: "muted", text: t("dayDetail.chip.cameraOffline", { defaultValue: "Camera offline during the day" }) as string });
      }
      break;
    case "waiting":
      title = t("dayDetail.hero.waiting.title", { defaultValue: "Shift still open · not detected yet" }) as string;
      meaning = d.policy_shift_end
        ? (t("dayDetail.hero.waiting.meaning", { defaultValue: "The shift runs until {{end}}. This updates as soon as a camera detects them.", end: time(d.policy_shift_end) }) as string)
        : (t("calendar.waitingSubtitle", { defaultValue: "The shift window is still open. Attendance will update as detections come in." }) as string);
      break;
    case "leave":
      title = d.leave_name
        ? (t("dayDetail.hero.leave.titleNamed", { defaultValue: "On leave · {{name}}", name: d.leave_name }) as string)
        : (t("dailyAttendance.pill.onLeave", { defaultValue: "On leave" }) as string);
      meaning = t("dayDetail.hero.leave.meaning", { defaultValue: "Approved leave covers this day." }) as string;
      if (view.worked) chips.push({ tone: "late", text: t("dayDetail.chip.detectedOnLeave", { defaultValue: "Detected while on leave" }) as string });
      break;
    case "weekend":
      title = t("dayDetail.hero.weekend.title", { defaultValue: "Weekly off" }) as string;
      meaning = t("dayDetail.hero.weekend.meaning", { defaultValue: "{{day}} · no attendance expected.", day: weekday(isoDate) }) as string;
      break;
    case "weekend_worked":
      title = t("dayDetail.hero.weekendWorked.title", { defaultValue: "Worked on a weekly off day" }) as string;
      meaning = t("dayDetail.hero.weekendWorked.meaning", { defaultValue: "{{day}} is a weekly off · time worked is counted as overtime.", day: weekday(isoDate) }) as string;
      break;
    case "holiday":
      title = d.holiday_name
        ? (t("dayDetail.hero.holiday.titleNamed", { defaultValue: "Public holiday · {{name}}", name: d.holiday_name }) as string)
        : (t("dayDetail.hero.holiday.title", { defaultValue: "Public holiday" }) as string);
      meaning = t("dayDetail.hero.holiday.meaning", { defaultValue: "No attendance expected." }) as string;
      break;
    case "holiday_worked":
      title = t("dayDetail.hero.holidayWorked.title", { defaultValue: "Worked on a public holiday" }) as string;
      meaning = d.holiday_name
        ? (t("dayDetail.hero.holidayWorked.meaningNamed", { defaultValue: "{{name}} · time worked is counted as overtime.", name: d.holiday_name }) as string)
        : (t("dayDetail.hero.holidayWorked.meaning", { defaultValue: "Time worked on a public holiday is counted as overtime." }) as string);
      break;
    case "future":
      title = t("dayDetail.hero.future.title", { defaultValue: "Upcoming day" }) as string;
      meaning = t("dayDetail.hero.future.meaning", { defaultValue: "Attendance is computed once this day arrives and cameras report detections." }) as string;
      break;
    default:
      title = t("calendar.noRecord.fact1Title", { defaultValue: "No attendance record" }) as string;
      meaning = t("calendar.noRecord.note", { defaultValue: "This may indicate the employee was absent, the camera was offline, or this date predates the system setup." }) as string;
  }

  // Engine flags on a regular working day (Present / Late).
  if (view.earlyOut) {
    chips.push({ tone: "late", text: t("dayDetail.chip.earlyOut", { defaultValue: "Early out · left {{out}}", out: time(d.out_time) }) as string });
  }
  if (view.shortHours && view.requiredMinutes != null) {
    chips.push({
      tone: "late",
      text: t("dayDetail.chip.shortHours", {
        defaultValue: "Short hours · {{worked}} of {{required}}",
        worked: formatMinutes(d.total_minutes),
        required: formatMinutes(view.requiredMinutes),
      }) as string,
    });
  }
  if (ot > 0 && view.kind !== "absent") {
    chips.push({ tone: "worked", text: t("dayDetail.chip.overtime", { defaultValue: "+{{dur}} overtime", dur: formatMinutes(ot) }) as string });
  }
  if (view.overtimeDay && singleDetection) {
    chips.push({ tone: "muted", text: t("dayDetail.chip.singleDetection", { defaultValue: "Single detection · no hours to count" }) as string });
  }

  const showSubmit = heroOffersSubmit(d) && onSubmitException != null;
  const showEscalate = onRaiseEscalation != null && (view.kind === "waiting" || (view.kind === "absent" && view.absentSub !== "approved" && view.absentSub !== "pending"));

  return (
    <div className="dd-hero" aria-live="polite">
      <span aria-hidden className={`dd-hero-icon${view.kind === "waiting" ? " is-live" : ""}`}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {HERO_ICON[view.kind]}
        </svg>
      </span>
      <div className="dd-hero-body">
        <h3 className="dd-hero-title">{title}</h3>
        <p className="dd-hero-meaning">{meaning}</p>
        {chips.length > 0 && (
          <div className="dd-hero-chips">
            {chips.map((c, i) => (
              <span key={i} className={`dd-chip dd-tone-${c.tone}`}>{c.text}</span>
            ))}
          </div>
        )}
        {(showSubmit || showEscalate) && (
          <div className="dd-hero-actions">
            {showSubmit && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => onSubmitException?.(isoDate)}>
                <Icon name="plus" size={12} />
                {t("calendar.submitException", { defaultValue: "Submit exception" }) as string}
              </button>
            )}
            {showEscalate && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onRaiseEscalation ?? undefined}
                title={t("escalation.actionSub", { defaultValue: "If you believe the camera missed you, raise an escalation. It routes to your manager then HR, and updates your attendance automatically when approved." }) as string}
              >
                <Icon name="zap" size={12} />
                {t("escalation.raiseButton", { defaultValue: "Raise escalation" }) as string}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key numbers
// ---------------------------------------------------------------------------

function KeyFacts({ detail: d, view }: { detail: DayDetail; view: DayView }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();

  if (view.kind === "future" || view.kind === "no_record") return null;

  if (!view.worked) {
    // Nothing to count — show the day's context instead of four dashes.
    const time = (x: string | null | undefined) => dt.formatLocalTime(x ?? null) || "—";
    const ctx: Array<{ label: string; value: string }> = [];
    if (view.kind === "absent" || view.kind === "waiting" || view.kind === "escalation") {
      if (view.isFlex && d.policy_in_window_start && d.policy_in_window_end) {
        ctx.push({ label: t("dayDetail.fact.arrivalWindow", { defaultValue: "Arrival window" }) as string, value: `${time(d.policy_in_window_start)} – ${time(d.policy_in_window_end)}` });
      } else if (d.policy_shift_start && d.policy_shift_end) {
        ctx.push({ label: t("dayDetail.fact.expectedShift", { defaultValue: "Expected shift" }) as string, value: `${time(d.policy_shift_start)} – ${time(d.policy_shift_end)}` });
      }
      if (view.requiredMinutes != null) {
        ctx.push({ label: t("dayDetail.fact.required", { defaultValue: "Required" }) as string, value: formatMinutes(view.requiredMinutes) });
      }
    } else if (view.kind === "weekend") {
      const names = (d.weekend_days ?? [])
        .map((w) => WEEKDAYS_EN.findIndex((x) => x.toLowerCase() === w.toLowerCase()))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)
        .map((i) => t(`calendar.dow.${DOW_KEYS[i]}`) as string);
      ctx.push({ label: t("dayDetail.fact.weeklyOff", { defaultValue: "Weekly off days" }) as string, value: names.join(", ") || "—" });
    } else if (view.kind === "holiday") {
      ctx.push({ label: t("dayDetail.fact.holiday", { defaultValue: "Holiday" }) as string, value: d.holiday_name ?? "—" });
    } else if (view.kind === "leave") {
      ctx.push({ label: t("calendar.leave.typeLabel", { defaultValue: "Leave type" }) as string, value: d.leave_name ?? "—" });
    }
    ctx.push({
      label: t("dayDetail.fact.detections", { defaultValue: "Detections" }) as string,
      value: view.kind === "waiting"
        ? (t("dayDetail.fact.noneYet", { defaultValue: "None yet" }) as string)
        : (t("dayDetail.fact.none", { defaultValue: "None" }) as string),
    });
    return (
      <div className="dd-facts" role="group" aria-label={t("dayDetail.keyNumbers", { defaultValue: "Key numbers" }) as string} style={{ ["--dd-cols" as string]: ctx.length }}>
        {ctx.map((c, i) => (
          <Fact key={i} label={c.label} value={c.value} small />
        ))}
      </div>
    );
  }

  const total = d.total_minutes ?? null;
  const req = view.overtimeDay || view.kind === "leave" ? null : view.requiredMinutes;
  const progress = total != null && req ? Math.min(100, Math.round((total / req) * 100)) : null;
  const ot = d.overtime_minutes;

  return (
    <div className="dd-facts" role="group" aria-label={t("dayDetail.keyNumbers", { defaultValue: "Key numbers" }) as string}>
      <Fact label={t("calendar.inTime", { defaultValue: "In time" }) as string} value={dt.formatLocalTime(d.in_time ?? null) || "—"} />
      <Fact
        label={t("calendar.outTime", { defaultValue: "Out time" }) as string}
        value={dt.formatLocalTime(d.out_time ?? null) || "—"}
        muted={d.out_time == null}
        sub={d.in_time != null && d.out_time == null ? (t("dayDetail.singleDetection", { defaultValue: "Single detection" }) as string) : null}
      />
      <Fact
        label={t("dayDetail.hoursWorked", { defaultValue: "Hours worked" }) as string}
        value={total != null ? formatMinutes(total) : "—"}
        muted={total == null}
        suffix={req ? `/ ${formatMinutes(req)}` : null}
        sub={view.overtimeDay && total != null ? (t("dayDetail.allOvertime", { defaultValue: "All counted as overtime" }) as string) : null}
        progress={progress}
        progressTone={view.shortHours ? "late" : "present"}
      />
      <Fact
        label={t("calendar.overtime", { defaultValue: "Overtime" }) as string}
        value={ot > 0 ? `+${formatMinutes(ot)}` : "—"}
        muted={ot <= 0}
        accent={ot > 0}
      />
    </div>
  );
}

function Fact({
  label,
  value,
  sub = null,
  suffix = null,
  muted = false,
  accent = false,
  progress = null,
  progressTone = "present",
  small = false,
}: {
  label: string;
  value: string;
  sub?: string | null;
  suffix?: string | null;
  muted?: boolean;
  accent?: boolean;
  progress?: number | null;
  progressTone?: string;
  small?: boolean;
}) {
  return (
    <div className="dd-fact">
      <div className="dd-label">{label}</div>
      <div className={`dd-fact-value${muted ? " is-muted" : ""}${accent ? " is-accent" : ""}${small ? " is-small" : ""}`}>
        {value}
        {suffix && <span className="dd-fact-suffix">{suffix}</span>}
      </div>
      {progress != null && (
        <div className={`dd-bar dd-tone-${progressTone}`} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      {sub && <div className="dd-fact-sub">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy & weekly schedule
// ---------------------------------------------------------------------------

function PolicyScheduleCard({ detail: d, isoDate }: { detail: DayDetail; isoDate: string }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const time = (s: string | null | undefined) => dt.formatLocalTime(s ?? null) || "—";

  const isFlex = d.policy_type === "Flex" || (d.policy_type === "Custom" && d.policy_custom_inner_type === "Flex");
  const isDefault = ["tenant-default", "legacy"].includes((d.policy_scope ?? "").toLowerCase());

  const facts: Array<{ label: string; value: string }> = [];
  if (isFlex) {
    if (d.policy_in_window_start && d.policy_in_window_end) {
      facts.push({ label: t("dayDetail.policy.arrive", { defaultValue: "Arrive" }) as string, value: `${time(d.policy_in_window_start)} – ${time(d.policy_in_window_end)}` });
    }
    if (d.policy_out_window_start && d.policy_out_window_end) {
      facts.push({ label: t("dayDetail.policy.leave", { defaultValue: "Leave" }) as string, value: `${time(d.policy_out_window_start)} – ${time(d.policy_out_window_end)}` });
    }
  } else if (d.policy_shift_start && d.policy_shift_end) {
    facts.push({ label: t("dayDetail.policy.shift", { defaultValue: "Shift" }) as string, value: `${time(d.policy_shift_start)} – ${time(d.policy_shift_end)}` });
  }
  if (d.policy_required_hours != null) {
    facts.push({ label: t("dayDetail.fact.required", { defaultValue: "Required" }) as string, value: t("dayDetail.policy.hours", { defaultValue: "{{hours}} h", hours: d.policy_required_hours }) as string });
  }
  if (!isFlex && d.policy_grace_minutes != null && d.policy_grace_minutes > 0) {
    facts.push({ label: t("dayDetail.policy.grace", { defaultValue: "Grace" }) as string, value: t("dayDetail.policy.minutes", { defaultValue: "{{min}} min", min: d.policy_grace_minutes }) as string });
  }
  if (d.policy_range_start || d.policy_range_end) {
    facts.push({
      label: t("calendar.policyActiveRange", { defaultValue: "Active range" }) as string,
      value: `${dt.formatLocalDate(d.policy_range_start ?? null) || "…"} – ${dt.formatLocalDate(d.policy_range_end ?? null) || "…"}`,
    });
  }

  const offDays = new Set((d.weekend_days ?? []).map((x) => x.toLowerCase()));
  const dow = new Date(`${isoDate}T00:00:00`).getDay();

  return (
    <section className="dd-card dd-policy" aria-label={t("calendar.policyApplied", { defaultValue: "Policy applied" }) as string}>
      <div className="dd-policy-main">
        <div className="dd-label">{t("calendar.policyApplied", { defaultValue: "Policy applied" }) as string}</div>
        {d.policy_name ? (
          <>
            <div className="dd-policy-name">
              <span>{d.policy_name}</span>
              {d.policy_type && <span className={`dd-type dd-type-${d.policy_type.toLowerCase()}`}>{d.policy_type}</span>}
              {isDefault && <span className="dd-type">{t("calendar.policyDefault", { defaultValue: "Default" }) as string}</span>}
            </div>
            {facts.length > 0 && (
              <dl className="dd-policy-facts">
                {facts.map((f, i) => (
                  <div key={i}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {d.policy_description && <p className="dd-policy-desc">{d.policy_description}</p>}
          </>
        ) : (
          <div className="dd-policy-none">
            {t("calendar.noPolicy", { defaultValue: "No policy applied for this day." }) as string}
          </div>
        )}
      </div>
      <div className="dd-week">
        <div className="dd-label">{t("calendar.weekOff.weeklySchedule", { defaultValue: "Weekly schedule" }) as string}</div>
        <ol className="dd-week-row">
          {DOW_KEYS.map((k, i) => {
            const off = offDays.has(WEEKDAYS_EN[i]!.toLowerCase());
            const label = t(`calendar.dow.${k}`) as string;
            const state = off
              ? (t("calendar.weekOff.stripOff", { defaultValue: "Off" }) as string)
              : (t("calendar.weekOff.stripWork", { defaultValue: "Work" }) as string);
            return (
              <li
                key={k}
                className={`${off ? "is-off" : "is-work"}${i === dow ? " is-today" : ""}`}
                title={`${label} · ${state}`}
                aria-label={`${label}: ${state}`}
                aria-current={i === dow ? "date" : undefined}
              >
                <span className="dd-week-day">{label}</span>
                <span aria-hidden className="dd-week-dot" />
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function EvidenceSection({
  detail: d,
  isoDate,
  highlightedEventId,
  registerRef,
}: {
  detail: DayDetail;
  isoDate: string;
  highlightedEventId: number | null;
  registerRef: (eventId: number, el: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  const best = bestConfidence(d.evidence);
  const n = d.evidence.length;

  return (
    <DdSection
      title={`${t("calendar.evidence", { defaultValue: "Evidence" }) as string}${n > 0 ? ` · ${n}` : ""}`}
      aside={
        best != null ? (
          <span className={`dd-chip dd-tone-${best >= 0.75 ? "present" : best >= 0.5 ? "late" : "absent"}`}>
            {t("calendar.bestConfidence", { defaultValue: "Best match" }) as string} {(best * 100).toFixed(0)}%
          </span>
        ) : null
      }
    >
      {n === 0 ? (
        <div className="dd-empty">
          <div className="dd-empty-title">
            {t("calendar.emptyEvidencePresent.title", { defaultValue: "No face crops retained for this day" }) as string}
          </div>
          <div>
            {t("calendar.emptyEvidencePresent.sub", { defaultValue: "Crops may have been swept by the retention policy. Detection events are still recorded." }) as string}
          </div>
        </div>
      ) : (
        <>
          <p className="dd-hint">
            <Icon name="info" size={12} />
            <span>
              {t("dayDetail.anomalyHint", {
                defaultValue:
                  "Cameras can miss events because of positioning, capture limits, lighting or brightness — treat a missing detection as a possible anomaly.",
              }) as string}
              {" "}
              <span className="dd-hint-soft">
                {t("calendar.clickToExpand", { defaultValue: "Click any crop to preview" }) as string}
              </span>
            </span>
          </p>
          <EvidenceGallery
            evidence={d.evidence}
            highlightedEventId={highlightedEventId}
            registerRef={registerRef}
            isoDate={isoDate}
          />
        </>
      )}
    </DdSection>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function DdSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="dd-section">
      <header className="dd-section-head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** Shape-matched to the layout: hero · 4 facts · timeline · policy · crops. */
function DayDetailSkeleton() {
  return (
    <div className="dd dd-skel" role="status" aria-label="Loading">
      <SkeletonLine width="38%" height={11} />
      <div className="dd-skel-hero">
        <SkeletonLine width={44} height={44} radius={12} />
        <div className="dd-skel-col">
          <SkeletonLine width="55%" height={16} />
          <SkeletonLine width="80%" height={11} />
          <SkeletonLine width="30%" height={18} radius={999} />
        </div>
      </div>
      <div className="dd-skel-facts">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="dd-skel-col">
            <SkeletonLine width="50%" height={10} />
            <SkeletonLine width="70%" height={16} />
          </div>
        ))}
      </div>
      <SkeletonLine width="22%" height={12} />
      <SkeletonLine height={92} radius={12} />
      <SkeletonLine height={88} radius={14} />
      <SkeletonLine width="22%" height={12} />
      <div className="dd-skel-grid">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonLine key={i} height={150} radius={12} />
        ))}
      </div>
    </div>
  );
}
