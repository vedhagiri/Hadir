// Minimal human-readable cron preview. Covers the common shapes the
// pilot UX exposes (every-N-minutes, hourly, daily, weekly, monthly)
// and falls back to the raw expression. We intentionally avoid a
// heavy cron-i18n package — the UI also surfaces the API-computed
// ``next_run_at`` timestamp for any expression that isn't templated.

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [m, h, dom, mon, dow] = parts;

  // Every-N-minutes patterns: */N * * * *
  if (m && m.startsWith("*/") && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${m.slice(2)} minutes`;
  }

  // Hourly at minute M: M * * * *
  const minutesNum = m ? Number(m) : NaN;
  const hoursNum = h ? Number(h) : NaN;
  if (
    Number.isFinite(minutesNum) &&
    h === "*" &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Every hour at :${pad2(minutesNum)}`;
  }

  // Daily at H:M: M H * * *
  if (
    Number.isFinite(minutesNum) &&
    Number.isFinite(hoursNum) &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Every day at ${pad2(hoursNum)}:${pad2(minutesNum)}`;
  }

  // Weekly: M H * * D — D may be 0-6 or three-letter day code
  if (
    Number.isFinite(minutesNum) &&
    Number.isFinite(hoursNum) &&
    dom === "*" &&
    mon === "*" &&
    dow !== "*"
  ) {
    const dowNum = Number(dow);
    if (Number.isInteger(dowNum) && dowNum >= 0 && dowNum <= 6) {
      return `Every ${DAYS[dowNum]} at ${pad2(hoursNum)}:${pad2(minutesNum)}`;
    }
    return `Every ${dow} at ${pad2(hoursNum)}:${pad2(minutesNum)}`;
  }

  // Monthly on day D at H:M: M H D * *
  const domNum = dom ? Number(dom) : NaN;
  if (
    Number.isFinite(minutesNum) &&
    Number.isFinite(hoursNum) &&
    Number.isFinite(domNum) &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Day ${domNum} of every month at ${pad2(hoursNum)}:${pad2(minutesNum)}`;
  }

  return expr;
}
