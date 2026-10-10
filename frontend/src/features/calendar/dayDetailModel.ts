// Pure view-model for the Day detail panel. Takes the API's DayDetail
// and decides which status hero to render, which flags apply and which
// sections are meaningful. No React, no network — every value here is
// read from (or derived with the engine's own formula from) the API
// response, never invented.
//
// Status precedence is the backend's (attendance_calendar/queries.py):
//   future > leave > holiday > weekend > waiting > absent >
//   escalation-present > late > present > no_record
// The panel only refines that status — "worked on a week off / holiday"
// (detections exist on a non-working day) and the escalation override.

import { calcLateMinutes } from "./PersonView";
import type { DayDetail } from "./types";

export type DayKind =
  | "present"
  | "late"
  | "escalation"
  | "absent"
  | "waiting"
  | "leave"
  | "weekend"
  | "weekend_worked"
  | "holiday"
  | "holiday_worked"
  | "future"
  | "no_record";

/** CSS tone suffix → ``dd-tone-<tone>`` in day-detail.css. */
export type DayTone =
  | "present"
  | "late"
  | "absent"
  | "waiting"
  | "leave"
  | "weekoff"
  | "worked"
  | "holiday"
  | "muted";

export type AbsentSub = "approved" | "pending" | "camera_offline" | "plain";

export interface DayView {
  kind: DayKind;
  tone: DayTone;
  /** Any detection / presence on the day. */
  worked: boolean;
  /** Detections on a holiday / weekly off — the engine routes the whole
   *  in→out span to overtime (engine.py ``is_overtime_day``). */
  overtimeDay: boolean;
  isFlex: boolean;
  /** Fixed: shift start; Flex: end of the arrival window. */
  expectedIn: string | null;
  graceMinutes: number;
  lateByMinutes: number | null;
  /** Engine flags re-derived with the engine's exact formulas (the API
   *  returns only the status, not the flag booleans). Regular working
   *  days only — the engine skips flag math on holidays / week offs. */
  earlyOut: boolean;
  shortHours: boolean;
  requiredMinutes: number | null;
  absentSub: AbsentSub | null;
}

export function toMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const parts = s.split(":");
  const h = parseInt(parts[0] ?? "", 10);
  const m = parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function didWork(d: DayDetail): boolean {
  return (
    d.in_time != null ||
    (d.total_minutes != null && d.total_minutes > 0) ||
    d.timeline.length > 0
  );
}

export function absentSubState(d: DayDetail): AbsentSub {
  if (d.approved_request != null) return "approved";
  if (d.pending_request != null) return "pending";
  if (d.camera_gaps.length > 0) return "camera_offline";
  return "plain";
}

export function isFlexPolicy(d: DayDetail): boolean {
  return (
    d.policy_type === "Flex" ||
    (d.policy_type === "Custom" && d.policy_custom_inner_type === "Flex")
  );
}

export function buildDayView(d: DayDetail): DayView {
  const worked = didWork(d);
  const isFlex = isFlexPolicy(d);
  const graceMinutes = isFlex ? 0 : (d.policy_grace_minutes ?? 0);
  const expectedIn = isFlex
    ? (d.policy_in_window_end ?? null)
    : (d.policy_shift_start ?? null);
  const requiredMinutes =
    d.policy_required_hours != null ? d.policy_required_hours * 60 : null;

  let kind: DayKind;
  switch (d.status) {
    case "present":
      kind = d.escalation_confirmed ? "escalation" : "present";
      break;
    case "escalation_present":
      kind = "escalation";
      break;
    case "late":
      kind = d.escalation_confirmed ? "escalation" : "late";
      break;
    case "absent":
      kind = "absent";
      break;
    case "waiting":
      kind = "waiting";
      break;
    case "leave":
      kind = d.escalation_confirmed ? "escalation" : "leave";
      break;
    case "weekend":
      kind = d.escalation_confirmed ? "escalation" : worked ? "weekend_worked" : "weekend";
      break;
    case "holiday":
      kind = d.escalation_confirmed ? "escalation" : worked ? "holiday_worked" : "holiday";
      break;
    case "future":
      kind = "future";
      break;
    default:
      kind = "no_record";
  }

  const tone: DayTone = (
    {
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
    } as const
  )[kind];

  const overtimeDay = worked && (d.is_holiday || d.is_weekend);

  const lateByMinutes =
    kind === "late" && d.in_time && expectedIn
      ? calcLateMinutes(d.in_time, expectedIn, graceMinutes)
      : null;

  // engine.py _fixed_flags / _flex_flags, verbatim.
  let earlyOut = false;
  let shortHours = false;
  if ((kind === "present" || kind === "late") && !overtimeDay) {
    const out = toMinutes(d.out_time);
    if (out != null) {
      if (isFlex) {
        const outStart = toMinutes(d.policy_out_window_start);
        earlyOut = outStart != null && out < outStart;
      } else {
        const end = toMinutes(d.policy_shift_end);
        if (end != null) {
          const endMinusGrace = (((end - graceMinutes) % 1440) + 1440) % 1440;
          earlyOut = out < endMinusGrace;
        }
      }
    }
    shortHours =
      d.total_minutes != null &&
      requiredMinutes != null &&
      d.total_minutes < requiredMinutes;
  }

  return {
    kind,
    tone,
    worked,
    overtimeDay,
    isFlex,
    expectedIn,
    graceMinutes,
    lateByMinutes,
    earlyOut,
    shortHours,
    requiredMinutes,
    absentSub: kind === "absent" ? absentSubState(d) : null,
  };
}

/** True when the status hero carries the "Submit exception" CTA itself,
 *  so the drawer footer doesn't repeat it. */
export function heroOffersSubmit(d: DayDetail): boolean {
  const v = buildDayView(d);
  return (v.kind === "absent" && v.absentSub !== "approved" && v.absentSub !== "pending") || v.kind === "waiting";
}

/** Policy shading bands for the timeline, minutes since midnight. An
 *  overnight shift (end < start) is split into two bands. */
export interface WindowBand {
  start: number;
  end: number;
  kind: "shift" | "edge";
}

export function policyBands(d: DayDetail): WindowBand[] {
  const out: WindowBand[] = [];
  const push = (s: number | null, e: number | null, kind: WindowBand["kind"]) => {
    if (s == null || e == null) return;
    if (e > s) out.push({ start: s, end: e, kind });
    else if (e < s) {
      out.push({ start: s, end: 1440, kind });
      out.push({ start: 0, end: e, kind });
    }
  };
  if (isFlexPolicy(d)) {
    const inS = toMinutes(d.policy_in_window_start);
    const inE = toMinutes(d.policy_in_window_end);
    const outS = toMinutes(d.policy_out_window_start);
    const outE = toMinutes(d.policy_out_window_end);
    push(inS, inE, "edge");
    push(inE, outS, "shift");
    push(outS, outE, "edge");
  } else {
    push(toMinutes(d.policy_shift_start), toMinutes(d.policy_shift_end), "shift");
  }
  return out;
}
