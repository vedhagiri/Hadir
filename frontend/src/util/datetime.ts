// Tenant-aware datetime formatting (migration 0068).
//
// Every page that renders a timestamp pulls its formatter from here.
// One place picks up the tenant's timezone + date_format + time_format
// from ``/api/auth/me``, applies them via ``Intl.DateTimeFormat``, and
// returns three stable functions (``formatDateTime`` / ``formatDate``
// / ``formatTime``) plus a relative-time helper.
//
// Why centralised:
//   * Browser timezone ≠ tenant timezone in general (Bangalore browser
//     showing an Oman tenant's events would otherwise display +5:30
//     while the engine computed in +4).
//   * Date/time format choice should propagate the moment an operator
//     flips it in Settings → Workspace — no per-page wiring.
//   * Backend reports (PDF / Excel / ERP) read the same tenant fields,
//     so UI + exports stay in sync.
//
// Fallbacks: if /me hasn't resolved yet (first render before the auth
// fetch), we render with Asia/Muscat + DD/MM/YYYY + 24h. Same defaults
// the backend uses, so the first frame matches the steady state.

import { useMe } from "../auth/AuthProvider";

export type DateFormat = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
export type TimeFormat = "12h" | "24h";

const DEFAULT_TZ = "Asia/Muscat";
const DEFAULT_DATE_FMT: DateFormat = "DD/MM/YYYY";
const DEFAULT_TIME_FMT: TimeFormat = "24h";

/**
 * Build an ISO datetime for a date-only day ("YYYY-MM-DD") at the given
 * wall-clock time, stamped with the viewer's LOCAL timezone offset
 * (e.g. "2026-06-09T23:59:59+04:00").
 *
 * Used for clip date-range filters so the day boundaries sent to the API
 * line up with the locally-rendered clip times — a plain naive bound is
 * treated as UTC by the database, which leaks the next day's early-morning
 * clips into a single-day filter.
 */
export function dayBound(day: string, time: string): string {
  const d = new Date(`${day}T${time}`);
  const mins = -d.getTimezoneOffset(); // minutes east of UTC (UTC+4 → 240)
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${day}T${time}${sign}${hh}:${mm}`;
}

export interface TenantDateTime {
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  /**
   * Full datetime: ``<date> <time>``. Returns ``""`` on null/undefined
   * input so JSX can render ``{formatDateTime(x)}`` without guards.
   */
  formatDateTime(value: string | Date | null | undefined): string;
  /** Date only. Honours the tenant's date_format. */
  formatDate(value: string | Date | null | undefined): string;
  /** Time only. Honours the tenant's time_format (12h vs 24h). */
  formatTime(value: string | Date | null | undefined): string;
  /** Time with seconds (forensic surfaces — camera logs / audit log). */
  formatTimeWithSeconds(value: string | Date | null | undefined): string;
  /**
   * Compact "5 minutes ago" / "2 hours ago" — useful for notification
   * bell + audit log freshness. Falls back to ``formatDateTime`` when
   * the gap exceeds a week.
   */
  formatRelative(value: string | Date | null | undefined): string;
  /**
   * Format a pre-converted local date string ("YYYY-MM-DD"). No
   * timezone conversion happens here — the backend has already done
   * that. Use this for date columns the API returns as bare ISO
   * dates (e.g. attendance_records.date, clip start_at::date).
   */
  formatLocalDate(yyyymmdd: string | null | undefined): string;
  /**
   * Format a pre-converted local time string ("HH:MM" or "HH:MM:SS").
   * No timezone conversion — backend has done that. Use this for
   * in_time / out_time / start_time etc. that the API returns as
   * tenant-local clock strings.
   */
  formatLocalTime(
    hhmmss: string | null | undefined,
    options?: { withSeconds?: boolean },
  ): string;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickDateParts(
  date: Date,
  timezone: string,
): { day: string; month: string; year: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  let day = "01";
  let month = "01";
  let year = "1970";
  for (const p of parts) {
    if (p.type === "day") day = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "year") year = p.value;
  }
  return { day, month, year };
}

function pickTimeParts(
  date: Date,
  timezone: string,
  timeFormat: TimeFormat,
  withSeconds: boolean,
): { hour: string; minute: string; second: string; ampm: string } {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: timeFormat === "12h",
  };
  if (withSeconds) opts.second = "2-digit";
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(date);
  let hour = "00";
  let minute = "00";
  let second = "00";
  let ampm = "";
  for (const p of parts) {
    if (p.type === "hour") hour = p.value;
    else if (p.type === "minute") minute = p.value;
    else if (p.type === "second") second = p.value;
    else if (p.type === "dayPeriod") ampm = p.value.toUpperCase();
  }
  return { hour, minute, second, ampm };
}

function assembleDate(parts: { day: string; month: string; year: string }, fmt: DateFormat): string {
  switch (fmt) {
    case "DD/MM/YYYY":
      return `${parts.day}/${parts.month}/${parts.year}`;
    case "MM/DD/YYYY":
      return `${parts.month}/${parts.day}/${parts.year}`;
    case "YYYY-MM-DD":
      return `${parts.year}-${parts.month}-${parts.day}`;
  }
}

function assembleTime(
  parts: { hour: string; minute: string; second: string; ampm: string },
  fmt: TimeFormat,
  withSeconds: boolean,
): string {
  const body = withSeconds
    ? `${parts.hour}:${parts.minute}:${parts.second}`
    : `${parts.hour}:${parts.minute}`;
  if (fmt === "12h" && parts.ampm) return `${body} ${parts.ampm}`;
  return body;
}

/**
 * Build a {@link TenantDateTime} bundle from explicit settings. Use
 * this when you need to format outside React (e.g. a CSV builder)
 * and already have the tenant settings in hand. React components
 * should call {@link useTenantDateTime} instead.
 */
export function makeTenantDateTime(
  timezone: string,
  dateFormat: DateFormat,
  timeFormat: TimeFormat,
): TenantDateTime {
  // Defensive: Intl.DateTimeFormat throws on an unknown IANA name;
  // probe once at construction so we can swap to the default instead
  // of crashing every render that touches it.
  let effectiveTz = timezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    effectiveTz = DEFAULT_TZ;
  }

  return {
    timezone: effectiveTz,
    dateFormat,
    timeFormat,
    formatDateTime(value) {
      const d = toDate(value);
      if (!d) return "";
      const date = assembleDate(pickDateParts(d, effectiveTz), dateFormat);
      const time = assembleTime(
        pickTimeParts(d, effectiveTz, timeFormat, false),
        timeFormat,
        false,
      );
      return `${date} ${time}`;
    },
    formatDate(value) {
      const d = toDate(value);
      if (!d) return "";
      return assembleDate(pickDateParts(d, effectiveTz), dateFormat);
    },
    formatTime(value) {
      const d = toDate(value);
      if (!d) return "";
      return assembleTime(
        pickTimeParts(d, effectiveTz, timeFormat, false),
        timeFormat,
        false,
      );
    },
    formatTimeWithSeconds(value) {
      const d = toDate(value);
      if (!d) return "";
      return assembleTime(
        pickTimeParts(d, effectiveTz, timeFormat, true),
        timeFormat,
        true,
      );
    },
    formatRelative(value) {
      const d = toDate(value);
      if (!d) return "";
      const diffMs = Date.now() - d.getTime();
      if (diffMs < 0) {
        // Future timestamp — fall through to absolute.
        const date = assembleDate(pickDateParts(d, effectiveTz), dateFormat);
        const time = assembleTime(
          pickTimeParts(d, effectiveTz, timeFormat, false),
          timeFormat,
          false,
        );
        return `${date} ${time}`;
      }
      const sec = Math.floor(diffMs / 1000);
      if (sec < 60) return "just now";
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
      const day = Math.floor(hr / 24);
      if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
      // >7 days → fall through to absolute.
      const date = assembleDate(pickDateParts(d, effectiveTz), dateFormat);
      const time = assembleTime(
        pickTimeParts(d, effectiveTz, timeFormat, false),
        timeFormat,
        false,
      );
      return `${date} ${time}`;
    },
    formatLocalDate(yyyymmdd) {
      if (!yyyymmdd) return "";
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(yyyymmdd);
      if (!m) return yyyymmdd;
      const [, year, month, day] = m;
      return assembleDate({ year: year!, month: month!, day: day! }, dateFormat);
    },
    formatLocalTime(hhmmss, options) {
      if (!hhmmss) return "";
      const withSeconds = options?.withSeconds ?? false;
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(hhmmss);
      if (!m) return hhmmss;
      const hour = parseInt(m[1]!, 10);
      const minute = m[2]!;
      const second = m[3] ?? "00";
      if (timeFormat === "24h") {
        const h = String(hour).padStart(2, "0");
        if (withSeconds) return `${h}:${minute}:${second}`;
        return `${h}:${minute}`;
      }
      // 12h
      const ampm = hour < 12 ? "AM" : "PM";
      let h12 = hour % 12;
      if (h12 === 0) h12 = 12;
      const h = String(h12).padStart(2, "0");
      if (withSeconds) return `${h}:${minute}:${second} ${ampm}`;
      return `${h}:${minute} ${ampm}`;
    },
  };
}

/**
 * React hook — reads tenant timezone + format from ``/api/auth/me``
 * via {@link useMe}. Re-renders the consuming component whenever the
 * operator changes a format in Settings → Workspace (the cache
 * invalidation from the PATCH mutation propagates through useMe).
 */
export function useTenantDateTime(): TenantDateTime {
  const me = useMe();
  const tz = me.data?.tenant_timezone ?? DEFAULT_TZ;
  const dateFmt = (me.data?.tenant_date_format ?? DEFAULT_DATE_FMT) as DateFormat;
  const timeFmt = (me.data?.tenant_time_format ?? DEFAULT_TIME_FMT) as TimeFormat;
  return makeTenantDateTime(tz, dateFmt, timeFmt);
}
