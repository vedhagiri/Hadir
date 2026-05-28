// Canonical attendance duration formatter. Returns "8h 45m" / "9h 05m" /
// "45m" / "0m" / "—" — the same shape across Daily Attendance, Day Detail,
// Calendar, Employee Attendance, Reports, and Dashboard summary cards.
//
// Replaces the previous mix of ``(min/60).toFixed(1)+'h'`` (loses minutes),
// ``HH:MM`` (ambiguous with clock times), and per-page local helpers.

export function formatMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min < 0) return "—";
  const total = Math.round(min);
  if (total === 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

// Same shape with a leading "+", for overtime tiles / pills. Returns "—"
// when overtime is null / 0 / negative — callers that want a different
// idle string (e.g. "0h") should branch themselves.
export function formatOvertime(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return "—";
  return `+${formatMinutes(min)}`;
}
