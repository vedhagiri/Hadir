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
import { SkeletonPanel } from "../components/Skeleton";
import { Icon } from "../shell/Icon";
import {
  useRegenerateAttendanceRange,
  usePatchTenantSettings,
  useTenantSettings,
  type RegenerateRangeResponse,
} from "../leave-calendar/hooks";
import {
  ChoiceChip,
  FormField,
  InlineAlert,
  LoadErrorPanel,
  SettingsCard,
  SettingsModal,
  SettingsPage,
} from "./settingsUi";

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
      setSavedToast(t("settingsUi.workspace.tzSaved", { defaultValue: "Timezone set to {{tz}}", tz }));
      if (oldTz && oldTz !== tz) {
        setPreviousTz(oldTz);
        setTzJustChanged(true);
      }
    } catch (err) {
      setError(extractError(err, t));
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
      setSavedToast(t("settingsUi.workspace.weekendSaved", { defaultValue: "Weekend days updated" }));
    } catch (err) {
      setError(extractError(err, t));
    }
  };

  // Migration 0068 — date / time format pickers. Both write through
  // the same patch mutation; useMe is invalidated on success so every
  // useTenantDateTime consumer re-renders with the new choice.
  const onSelectDateFormat = async (
    fmt: "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD",
  ) => {
    setError(null);
    setSavedToast(null);
    try {
      await patch.mutateAsync({ date_format: fmt });
      setSavedToast(t("settingsUi.workspace.dateFormatSaved", { defaultValue: "Date format set to {{fmt}}", fmt }));
    } catch (err) {
      setError(extractError(err, t));
    }
  };
  const onSelectTimeFormat = async (fmt: "12h" | "24h") => {
    setError(null);
    setSavedToast(null);
    try {
      await patch.mutateAsync({ time_format: fmt });
      setSavedToast(t("settingsUi.workspace.timeFormatSaved", { defaultValue: "Time format set to {{fmt}}", fmt }));
    } catch (err) {
      setError(extractError(err, t));
    }
  };

  return (
    <SettingsPage
      title={t("settings.workspace.title")}
      subtitle={t("settings.workspace.subtitle")}
    >
      {settings.isLoading && <SkeletonPanel lines={6} />}
      {settings.error && (
        <LoadErrorPanel
          title={t("settings.workspace.loadFailed")}
          onRetry={() => void settings.refetch()}
        />
      )}

      {settings.data && (
        <>
          {tzJustChanged && (
            <TimezoneChangedBanner
              previousTz={previousTz ?? t("settingsUi.workspace.previousTz", { defaultValue: "the previous timezone" })}
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
          <SettingsCard
            icon={<Icon name="clock" size={17} />}
            title={t("settings.workspace.timezoneTitle")}
            description={t("settings.workspace.timezoneDesc")}
          >
            <div className="st-form-grid">
              <FormField label={t("settings.workspace.timezoneLabel")} htmlFor="ws-timezone" span>
                <select
                  id="ws-timezone"
                  className="select"
                  value={customMode ? "__custom__" : settings.data.timezone}
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
              </FormField>

              {customMode && (
                <FormField label={t("settings.workspace.customLabel")} htmlFor="ws-timezone-custom" span>
                  <div className="st-inline">
                    <input
                      id="ws-timezone-custom"
                      type="text"
                      className="input mono"
                      value={customValue}
                      placeholder="Continent/City"
                      onChange={(e) => setCustomValue(e.target.value)}
                      style={{ flex: 1, minWidth: 220 }}
                    />
                    <button
                      type="button"
                      className="btn"
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
                </FormField>
              )}

              <div className="st-span">
                <LiveClock timezone={settings.data.timezone} />
              </div>
            </div>
          </SettingsCard>

          {/* --- Date format card (migration 0068) --- */}
          <SettingsCard
            icon={<Icon name="calendar" size={17} />}
            title={t("settings.workspace.dateFormatTitle", "Date format")}
            description={t(
              "settings.workspace.dateFormatDesc",
              "Applied across every page, drawer, export, and notification email. Sample below uses today.",
            )}
          >
            <div className="st-chips" role="group" aria-label={t("settings.workspace.dateFormatTitle", "Date format")}>
              {(
                ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const
              ).map((fmt) => (
                <ChoiceChip
                  key={fmt}
                  on={settings.data!.date_format === fmt}
                  onClick={() => void onSelectDateFormat(fmt)}
                  disabled={patch.isPending}
                  sample={formatSampleDate(fmt)}
                >
                  <span className="mono">{fmt}</span>
                </ChoiceChip>
              ))}
            </div>
          </SettingsCard>

          {/* --- Time format card (migration 0068) --- */}
          <SettingsCard
            icon={<Icon name="clock" size={17} />}
            title={t("settings.workspace.timeFormatTitle", "Time format")}
            description={t(
              "settings.workspace.timeFormatDesc",
              "12-hour shows AM/PM; 24-hour is the GCC default. Applies to every timestamp the platform renders.",
            )}
          >
            <div className="st-chips" role="group" aria-label={t("settings.workspace.timeFormatTitle", "Time format")}>
              {(["24h", "12h"] as const).map((fmt) => (
                <ChoiceChip
                  key={fmt}
                  on={settings.data!.time_format === fmt}
                  onClick={() => void onSelectTimeFormat(fmt)}
                  disabled={patch.isPending}
                  sample={formatSampleTime(fmt)}
                >
                  {fmt === "24h"
                    ? t("settings.workspace.timeFormat24h", "24-hour")
                    : t("settings.workspace.timeFormat12h", "12-hour (AM/PM)")}
                </ChoiceChip>
              ))}
            </div>
          </SettingsCard>

          {/* --- Weekend days card --- */}
          <SettingsCard
            icon={<Icon name="calendar" size={17} />}
            title={t("settings.workspace.weekendTitle")}
            description={t("settings.workspace.weekendDesc")}
          >
            <div className="st-chips" role="group" aria-label={t("settings.workspace.weekendTitle")}>
              {WEEKDAYS.map((d) => (
                <ChoiceChip
                  key={d}
                  on={settings.data!.weekend_days.includes(d)}
                  onClick={() => void onToggleWeekendDay(d)}
                  disabled={patch.isPending}
                  title={d}
                >
                  {d.slice(0, 3)}
                </ChoiceChip>
              ))}
            </div>
          </SettingsCard>

          {savedToast && !error && (
            <InlineAlert tone="success" role="status">
              {savedToast}
            </InlineAlert>
          )}
          {error && (
            <InlineAlert tone="danger" role="alert">
              {error}
            </InlineAlert>
          )}
        </>
      )}
    </SettingsPage>
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
  const { t } = useTranslation();
  return (
    <InlineAlert
      tone="warning"
      role="alert"
      title={t("settingsUi.workspace.tzChangedTitle", {
        defaultValue: "Timezone changed — historical attendance may be stale.",
      })}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onRegenerate}>
            <Icon name="refresh" size={11} />
            {t("settingsUi.workspace.regenerateCta", { defaultValue: "Regenerate historical attendance…" })}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDismiss}>
            {t("settingsUi.workspace.dismiss", { defaultValue: "Dismiss" })}
          </button>
        </>
      }
    >
      {t("settingsUi.workspace.tzChangedBodyA", {
        defaultValue: "Today's attendance was automatically recomputed in",
      })}{" "}
      <code>{currentTz}</code>.{" "}
      {t("settingsUi.workspace.tzChangedBodyB", {
        defaultValue: "Past dates were computed in",
      })}{" "}
      <code>{previousTz}</code>;{" "}
      {t("settingsUi.workspace.tzChangedBodyC", {
        defaultValue:
          "in / out / total / late / overtime numbers near midnight may be off by the time difference. Regenerate a date range to refresh them.",
      })}
    </InlineAlert>
  );
}

function RegenerateHistoricalModal({
  currentTz,
  onClose,
}: {
  currentTz: string;
  onClose: (completed: boolean) => void;
}) {
  const { t } = useTranslation();
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
      setError(t("settingsUi.workspace.regenErrDates", { defaultValue: "Both start and end dates are required." }));
      return;
    }
    if (rangeDays === null) {
      setError(t("settingsUi.workspace.regenErrRange", { defaultValue: "Invalid date range." }));
      return;
    }
    if (rangeDays > 92) {
      setError(
        t("settingsUi.workspace.regenErrTooLong", {
          defaultValue: "Range is {{days}} days; maximum is 92. Split into smaller ranges.",
          days: rangeDays,
        }),
      );
      return;
    }
    try {
      const resp = await regenerate.mutateAsync({ start, end });
      setResult(resp);
    } catch (err) {
      setError(extractError(err, t));
    }
  };

  return (
    <SettingsModal
      labelledBy="regen-historical-title"
      title={t("settingsUi.workspace.regenTitle", { defaultValue: "Regenerate historical attendance" })}
      subtitle={
        <>
          {t("settingsUi.workspace.regenSubA", {
            defaultValue: "Recomputes attendance for every active employee on each date in the range. Uses the current timezone",
          })}{" "}
          <code>{currentTz}</code>.{" "}
          {t("settingsUi.workspace.regenSubB", { defaultValue: "Maximum 92 days per call." })}
        </>
      }
      onClose={() => onClose(result !== null)}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => onClose(result !== null)}
            disabled={regenerate.isPending}
          >
            {result ? t("common.close") : t("common.cancel")}
          </button>
          {!result && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onRun}
              disabled={regenerate.isPending || !rangeDays || rangeDays > 92}
            >
              {regenerate.isPending
                ? t("settingsUi.workspace.regenRunning", { defaultValue: "Regenerating…" })
                : t("settingsUi.workspace.regenRun", { defaultValue: "Run regenerate" })}
            </button>
          )}
        </>
      }
    >
      <div className="st-form-grid">
        <FormField label={t("settingsUi.workspace.regenStart", { defaultValue: "Start (inclusive)" })}>
          <DatePicker
            value={start}
            onChange={setStart}
            max={end || todayIso()}
            ariaLabel={t("settingsUi.workspace.regenStartAria", { defaultValue: "Start date" })}
          />
        </FormField>
        <FormField label={t("settingsUi.workspace.regenEnd", { defaultValue: "End (inclusive)" })}>
          <DatePicker
            value={end}
            onChange={setEnd}
            max={todayIso()}
            ariaLabel={t("settingsUi.workspace.regenEndAria", { defaultValue: "End date" })}
          />
        </FormField>
      </div>

      {rangeDays !== null && (
        <div className="text-xs text-dim">
          {t("settingsUi.workspace.regenDaysInRange", {
            defaultValue: "{{count}} days in range",
            count: rangeDays,
          })}
        </div>
      )}

      {error && (
        <InlineAlert tone="danger" role="alert">
          {error}
        </InlineAlert>
      )}

      {result && (
        <InlineAlert tone="success" role="status">
          {t("settingsUi.workspace.regenResultA", { defaultValue: "Recomputed" })}{" "}
          <strong>{result.total_rows_upserted}</strong>{" "}
          {t("settingsUi.workspace.regenResultRows", {
            defaultValue: "attendance rows",
            count: result.total_rows_upserted,
          })}{" "}
          {t("settingsUi.workspace.regenResultAcross", { defaultValue: "across" })}{" "}
          <strong>{result.days_processed}</strong>{" "}
          {t("settingsUi.workspace.regenResultDays", {
            defaultValue: "days",
            count: result.days_processed,
          })}{" "}
          (<span className="mono">{result.start}</span> → <span className="mono">{result.end}</span>).
        </InlineAlert>
      )}
    </SettingsModal>
  );
}

function LiveClock({ timezone }: { timezone: string }) {
  const { t } = useTranslation();
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
    formatted = t("settingsUi.workspace.invalidTz", { defaultValue: "Invalid timezone: {{tz}}", tz: timezone });
  }

  return (
    <div className="st-strip">
      <Icon name="clock" size={12} className="text-dim" />
      <span className="text-dim">{t("settingsUi.workspace.tenantClock", { defaultValue: "Tenant clock:" })}</span>
      <span className="mono">{formatted}</span>
    </div>
  );
}

function extractError(err: unknown, t: (k: string, o: { defaultValue: string }) => string): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return t("settingsUi.workspace.saveFailed", { defaultValue: "Save failed." });
}

// Workspace-page-local samples (independent of the tenant choice
// because the operator hasn't saved yet — the sample shows what the
// picked format would look like). Uses Intl with no timezone so the
// preview reflects the operator's wall clock rather than the tenant
// tz; that matches the chip-style "this is what DD/MM/YYYY means"
// preview an operator would expect.
function formatSampleDate(fmt: "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD"): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  if (fmt === "DD/MM/YYYY") return `${dd}/${mm}/${yyyy}`;
  if (fmt === "MM/DD/YYYY") return `${mm}/${dd}/${yyyy}`;
  return `${yyyy}-${mm}-${dd}`;
}
function formatSampleTime(fmt: "12h" | "24h"): string {
  const d = new Date();
  if (fmt === "24h") {
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
  const hours = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(h12).padStart(2, "0")}:${m} ${ampm}`;
}
