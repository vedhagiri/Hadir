// Settings → Workspace. Per-tenant timezone + weekend days.
//
// Maugood internally stores every timestamp in UTC. The tenant's
// timezone setting drives every wall-clock comparison the engine
// makes — shift boundaries, "today" rollover, scheduler firings,
// report dates. This page is where Admin / HR sets it.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { DatePicker, todayIso } from "../components/DatePicker";
import { ModalShell } from "../components/DrawerShell";
import { Icon } from "../shell/Icon";
import {
  useRegenerateAttendanceRange,
  usePatchTenantSettings,
  useTenantSettings,
  type RegenerateRangeResponse,
} from "../leave-calendar/hooks";
import { SettingsTabs } from "./SettingsTabs";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// Curated IANA timezone list. Covers the platform's expected
// markets first (GCC + South Asia), then a handful of global
// anchors. The Custom… option reveals a free-text input for
// anything outside this set.
const COMMON_TIMEZONES = [
  { value: "Asia/Muscat", label: "Asia/Muscat (UTC+4) — Oman" },
  { value: "Asia/Dubai", label: "Asia/Dubai (UTC+4) — UAE" },
  { value: "Asia/Riyadh", label: "Asia/Riyadh (UTC+3) — Saudi Arabia" },
  { value: "Asia/Qatar", label: "Asia/Qatar (UTC+3) — Qatar" },
  { value: "Asia/Bahrain", label: "Asia/Bahrain (UTC+3) — Bahrain" },
  { value: "Asia/Kuwait", label: "Asia/Kuwait (UTC+3) — Kuwait" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+5:30) — India" },
  { value: "Asia/Karachi", label: "Asia/Karachi (UTC+5) — Pakistan" },
  { value: "Asia/Dhaka", label: "Asia/Dhaka (UTC+6) — Bangladesh" },
  { value: "Asia/Singapore", label: "Asia/Singapore (UTC+8)" },
  { value: "Europe/London", label: "Europe/London (UTC+0/+1)" },
  { value: "Europe/Paris", label: "Europe/Paris (UTC+1/+2)" },
  { value: "America/New_York", label: "America/New_York (UTC-5/-4)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (UTC-8/-7)" },
  { value: "UTC", label: "UTC" },
] as const;

export function WorkspacePage() {
  const { t } = useTranslation();
  const settings = useTenantSettings();
  const patch = usePatchTenantSettings();

  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");

  // Surfaces the regenerate-historical CTA after a real timezone
  // change. `lastChangedTz` remembers the previous value so we can
  // compute whether the most-recent save was actually a tz flip
  // (vs. weekend-day toggle, which doesn't need regen).
  const [tzJustChanged, setTzJustChanged] = useState(false);
  const [previousTz, setPreviousTz] = useState<string | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const initialTzRef = useRef<string | null>(null);

  // Initial sync: if the saved timezone isn't in the curated list,
  // jump straight to Custom mode so the operator can see/edit it.
  useEffect(() => {
    if (!settings.data) return;
    if (initialTzRef.current === null) {
      initialTzRef.current = settings.data.timezone;
    }
    const inList = COMMON_TIMEZONES.some(
      (z) => z.value === settings.data!.timezone,
    );
    if (!inList) {
      setCustomMode(true);
      setCustomValue(settings.data.timezone);
    }
  }, [settings.data]);

  const onSelectTimezone = async (tz: string) => {
    setError(null);
    setSavedToast(null);
    const oldTz = settings.data?.timezone ?? null;
    try {
      await patch.mutateAsync({ timezone: tz });
      setSavedToast(`Timezone set to ${tz}`);
      if (oldTz && oldTz !== tz) {
        setPreviousTz(oldTz);
        setTzJustChanged(true);
      }
    } catch (err) {
      setError(extractError(err));
    }
  };

  const onSubmitCustom = async () => {
    const tz = customValue.trim();
    if (!tz) return;
    await onSelectTimezone(tz);
  };

  const onToggleWeekendDay = async (day: string) => {
    if (!settings.data) return;
    setError(null);
    setSavedToast(null);
    const current = new Set(settings.data.weekend_days);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    try {
      await patch.mutateAsync({ weekend_days: Array.from(current) });
      setSavedToast("Weekend days updated");
    } catch (err) {
      setError(extractError(err));
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("settings.workspace.title")}</h1>
          <p className="page-sub">{t("settings.workspace.subtitle")}</p>
        </div>
      </div>

      <SettingsTabs />

      {settings.isLoading && (
        <p className="text-sm text-dim">{t("common.loading")}…</p>
      )}
      {settings.error && (
        <p style={{ color: "var(--danger-text)" }}>
          {t("settings.workspace.loadFailed")}
        </p>
      )}

      {settings.data && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            maxWidth: 720,
          }}
        >
          {tzJustChanged && (
            <TimezoneChangedBanner
              previousTz={previousTz ?? "the previous timezone"}
              currentTz={settings.data.timezone}
              onRegenerate={() => setRegenOpen(true)}
              onDismiss={() => setTzJustChanged(false)}
            />
          )}

          {regenOpen && (
            <RegenerateHistoricalModal
              currentTz={settings.data.timezone}
              onClose={(completed) => {
                setRegenOpen(false);
                if (completed) setTzJustChanged(false);
              }}
            />
          )}

          {/* --- Timezone card --- */}
          <section
            className="card"
            style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}
          >
            <header>
              <h2 style={cardTitleStyle}>
                <Icon name="clock" size={13} />
                {t("settings.workspace.timezoneTitle")}
              </h2>
              <p style={cardSubStyle}>
                {t("settings.workspace.timezoneDesc")}
              </p>
            </header>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={labelStyle}>
                  {t("settings.workspace.timezoneLabel")}
                </span>
                <select
                  value={
                    customMode ? "__custom__" : settings.data.timezone
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__custom__") {
                      setCustomMode(true);
                      setCustomValue(settings.data!.timezone);
                    } else {
                      setCustomMode(false);
                      void onSelectTimezone(v);
                    }
                  }}
                  disabled={patch.isPending}
                  style={selectStyle}
                >
                  {COMMON_TIMEZONES.map((z) => (
                    <option key={z.value} value={z.value}>
                      {z.label}
                    </option>
                  ))}
                  <option value="__custom__">
                    {t("settings.workspace.customTimezone")}
                  </option>
                </select>
              </label>

              {customMode && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={labelStyle}>
                      {t("settings.workspace.customLabel")}
                    </span>
                    <input
                      type="text"
                      value={customValue}
                      placeholder="Continent/City"
                      onChange={(e) => setCustomValue(e.target.value)}
                      style={inputStyle}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={onSubmitCustom}
                    disabled={
                      patch.isPending ||
                      !customValue.trim() ||
                      customValue.trim() === settings.data.timezone
                    }
                  >
                    {patch.isPending ? "…" : t("common.save")}
                  </button>
                </div>
              )}
            </div>

            <LiveClock timezone={settings.data.timezone} />
          </section>

          {/* --- Weekend days card --- */}
          <section
            className="card"
            style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}
          >
            <header>
              <h2 style={cardTitleStyle}>
                <Icon name="calendar" size={13} />
                {t("settings.workspace.weekendTitle")}
              </h2>
              <p style={cardSubStyle}>
                {t("settings.workspace.weekendDesc")}
              </p>
            </header>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {WEEKDAYS.map((d) => {
                const on = settings.data!.weekend_days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => void onToggleWeekendDay(d)}
                    aria-pressed={on}
                    disabled={patch.isPending}
                    style={{
                      fontSize: 12,
                      padding: "6px 12px",
                      borderRadius: 999,
                      border: on
                        ? "1px solid var(--accent-border)"
                        : "1px solid var(--border)",
                      background: on ? "var(--accent-soft)" : "var(--bg)",
                      color: on ? "var(--accent-text)" : "var(--text)",
                      cursor: "pointer",
                      fontWeight: on ? 600 : 400,
                    }}
                  >
                    {d.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </section>

          {savedToast && !error && (
            <div
              role="status"
              style={{
                background: "var(--success-soft)",
                color: "var(--success-text)",
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                fontSize: 13,
              }}
            >
              {savedToast}
            </div>
          )}
          {error && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function TimezoneChangedBanner({
  previousTz,
  currentTz,
  onRegenerate,
  onDismiss,
}: {
  previousTz: string;
  currentTz: string;
  onRegenerate: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        background: "var(--warning-soft)",
        color: "var(--warning-text)",
        border: "1px solid var(--warning-border)",
        borderRadius: "var(--radius)",
        padding: "12px 14px",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <Icon name="info" size={14} />
      <div style={{ flex: 1, fontSize: 13, lineHeight: 1.5 }}>
        <strong style={{ display: "block", marginBottom: 4 }}>
          Timezone changed — historical attendance may be stale.
        </strong>
        <div>
          Today's attendance was automatically recomputed in{" "}
          <code>{currentTz}</code>. Past dates were computed in{" "}
          <code>{previousTz}</code>; in / out / total / late /
          overtime numbers near midnight may be off by the time
          difference. Regenerate a date range to refresh them.
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onRegenerate}
          >
            Regenerate historical attendance…
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function RegenerateHistoricalModal({
  currentTz,
  onClose,
}: {
  currentTz: string;
  onClose: (completed: boolean) => void;
}) {
  const regenerate = useRegenerateAttendanceRange();
  const [start, setStart] = useState<string>(() => {
    // Default: 7 days back (covers the past week — common request).
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [end, setEnd] = useState<string>(() => todayIso());
  const [result, setResult] = useState<RegenerateRangeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rangeDays = (() => {
    try {
      const s = new Date(start).getTime();
      const e = new Date(end).getTime();
      if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
      return Math.round((e - s) / 86400000) + 1;
    } catch {
      return null;
    }
  })();

  const onRun = async () => {
    setError(null);
    setResult(null);
    if (!start || !end) {
      setError("Both start and end dates are required.");
      return;
    }
    if (rangeDays === null) {
      setError("Invalid date range.");
      return;
    }
    if (rangeDays > 92) {
      setError(
        `Range is ${rangeDays} days; maximum is 92. Split into smaller ranges.`,
      );
      return;
    }
    try {
      const resp = await regenerate.mutateAsync({ start, end });
      setResult(resp);
    } catch (err) {
      setError(extractError(err));
    }
  };

  return (
    <ModalShell open onClose={() => onClose(result !== null)}>
      <div
        role="dialog"
        aria-labelledby="regen-historical-title"
        style={{
          // ModalShell renders only the scrim — the panel has to carry
          // its own fixed-position centering. Mirrors the pattern in
          // requests/OverrideModal.tsx so it sits in the middle of the
          // viewport instead of dropping into the page's document flow
          // (where it would render bottom-left after the long Settings
          // page content).
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 520,
          maxWidth: "90vw",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius)",
          padding: 20,
          zIndex: 60,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <header>
          <h2
            id="regen-historical-title"
            style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
          >
            Regenerate historical attendance
          </h2>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12.5,
              color: "var(--text-secondary)",
              lineHeight: 1.5,
            }}
          >
            Recomputes attendance for every active employee on each
            date in the range. Uses the current timezone{" "}
            <code>{currentTz}</code>. Maximum 92 days per call.
          </p>
        </header>

        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>Start (inclusive)</span>
            <DatePicker
              value={start}
              onChange={setStart}
              max={end || todayIso()}
              ariaLabel="Start date"
            />
          </label>
          <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>End (inclusive)</span>
            <DatePicker
              value={end}
              onChange={setEnd}
              max={todayIso()}
              ariaLabel="End date"
            />
          </label>
        </div>

        {rangeDays !== null && (
          <div className="text-xs text-dim">
            {rangeDays} day{rangeDays === 1 ? "" : "s"} in range
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
            }}
          >
            {error}
          </div>
        )}

        {result && (
          <div
            role="status"
            style={{
              background: "var(--success-soft)",
              color: "var(--success-text)",
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            Recomputed <strong>{result.total_rows_upserted}</strong>{" "}
            attendance row{result.total_rows_upserted === 1 ? "" : "s"}{" "}
            across <strong>{result.days_processed}</strong> day
            {result.days_processed === 1 ? "" : "s"} ({result.start} →{" "}
            {result.end}).
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onClose(result !== null)}
            disabled={regenerate.isPending}
          >
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onRun}
              disabled={regenerate.isPending || !rangeDays || rangeDays > 92}
            >
              {regenerate.isPending
                ? "Regenerating…"
                : "Run regenerate"}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function LiveClock({ timezone }: { timezone: string }) {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "medium",
    }).format(now);
  } catch {
    formatted = `Invalid timezone: ${timezone}`;
  }

  return (
    <div
      style={{
        marginTop: 4,
        padding: "8px 12px",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        fontSize: 12.5,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Icon name="check" size={11} className="text-secondary" />
      <span className="text-dim">Tenant clock:</span>
      <span className="mono" style={{ color: "var(--text)" }}>
        {formatted}
      </span>
    </div>
  );
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return "Save failed.";
}

const cardTitleStyle = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const cardSubStyle = {
  margin: "4px 0 0 0",
  color: "var(--text-secondary)",
  fontSize: 12,
  lineHeight: 1.5,
};

const labelStyle = {
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-tertiary)",
};

const inputStyle = {
  padding: "7px 10px",
  fontSize: 13,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
};

const selectStyle = {
  ...inputStyle,
  fontFamily: "var(--font-sans)",
  minWidth: 320,
};
